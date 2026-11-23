import type { Tx } from '../db/client';
import { appendTicketEvent } from '../events/ticket-events';
import { collectorOf } from '../realtime/collector';

export type SlaTarget = 'first_response' | 'resolution';

type Row = {
  id: string;
  team_id: string;
  assignee_id: string | null;
  status: string;
  number: bigint;
  subject: string;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  sla_paused: boolean;
  fr_warn: Date | null;
  fr_due: Date | null;
  res_warn: Date | null;
  res_due: Date | null;
};

const notify = async (
  tx: Tx,
  userIds: readonly string[],
  ticketId: string,
  kind: string,
  data: object,
  now: Date,
): Promise<void> => {
  for (const userId of userIds) {
    await tx.$executeRaw`
      INSERT INTO notifications (user_id, ticket_id, kind, data, created_at) VALUES (${userId}::uuid, ${ticketId}::uuid, ${kind}, ${JSON.stringify(data)}::jsonb, ${now})`;
  }
};

const leadsOf = async (tx: Tx, teamId: string): Promise<string[]> =>
  (
    await tx.$queryRaw<
      { user_id: string }[]
    >`SELECT m.user_id FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ${teamId}::uuid AND m.role = 'lead' AND u.is_active`
  ).map((r) => r.user_id);

const pending = async (
  tx: Tx,
  ticketId: string,
  target: SlaTarget,
  event: 'warning' | 'breach',
): Promise<boolean> =>
  (await tx.$executeRaw`
    UPDATE jobs SET status = 'done', completed_at = now() WHERE dedupe_key = ${`sla:${ticketId}:${target}:${event}`} AND status = 'pending'`) >
  0;

const warn = async (tx: Tx, t: Row, target: SlaTarget, now: Date): Promise<void> => {
  const recipients = t.assignee_id === null ? await leadsOf(tx, t.team_id) : [t.assignee_id];
  await appendTicketEvent(tx, {
    ticketId: t.id,
    type: 'sla_warning',
    actorKind: 'system',
    data: { target },
    at: now,
  });
  await notify(
    tx,
    recipients,
    t.id,
    'sla_warning',
    { target, number: Number(t.number), subject: t.subject },
    now,
  );
};

/**
 * Fires one SLA warning or breach in the caller's transaction (the job row is already locked by the runner).
 * Safe to run after a long outage: it checks the ticket's current state, and a breach first emits the warning
 * that was missed, so the history keeps its order and each event happens once.
 */
export const fireSlaEvent = async (
  tx: Tx,
  a: { ticketId: string; target: SlaTarget; event: 'warning' | 'breach'; now: Date },
): Promise<'fired' | 'not_applicable'> => {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT id, team_id, assignee_id, status, number, subject, first_responded_at, resolved_at, sla_paused,
           first_response_warn_at AS fr_warn, first_response_due_at AS fr_due, resolution_warn_at AS res_warn, resolution_due_at AS res_due
      FROM tickets WHERE id = ${a.ticketId}::uuid FOR UPDATE`;
  const t = rows[0];
  if (t === undefined || t.status === 'closed') return 'not_applicable';
  const isFirst = a.target === 'first_response';
  const done = isFirst ? t.first_responded_at !== null : t.resolved_at !== null || t.sla_paused;
  const warnAt = isFirst ? t.fr_warn : t.res_warn;
  const dueAt = isFirst ? t.fr_due : t.res_due;
  const threshold = a.event === 'warning' ? warnAt : dueAt;
  if (done || threshold === null || threshold.getTime() > a.now.getTime()) return 'not_applicable';

  if (a.event === 'warning') {
    await warn(tx, t, a.target, a.now);
    return 'fired';
  }
  if (await pending(tx, t.id, a.target, 'warning')) await warn(tx, t, a.target, a.now);
  collectorOf(tx).updated.add(t.id);
  const flag = isFirst ? 'first_response_breached' : 'resolution_breached';
  await tx.$executeRawUnsafe(
    `UPDATE tickets SET ${flag} = true, version = version + 1, updated_at = $1 WHERE id = $2::uuid`,
    a.now,
    t.id,
  );
  await appendTicketEvent(tx, {
    ticketId: t.id,
    type: 'sla_breach',
    actorKind: 'system',
    data: { target: a.target },
    at: a.now,
  });
  const leads = await leadsOf(tx, t.team_id);
  await notify(
    tx,
    leads,
    t.id,
    'sla_breach',
    { target: a.target, number: Number(t.number), subject: t.subject, assigneeId: t.assignee_id },
    a.now,
  );
  return 'fired';
};
