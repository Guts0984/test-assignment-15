import {
  computeSlaDeadlines,
  nextDueAt,
  type HoursCalendar,
  type Priority,
} from '@helpdesk/shared';
import type { Tx } from '../db/client';

export type TeamCalendar = { readonly calendar: HoursCalendar; readonly teamId: string };

export const loadCalendar = async (tx: Tx, teamId: string): Promise<HoursCalendar> => {
  const team = await tx.$queryRaw<
    { time_zone: string; workdays: number[]; work_start_min: number; work_end_min: number }[]
  >`
    SELECT time_zone, workdays, work_start_min, work_end_min FROM teams WHERE id = ${teamId}::uuid`;
  const t = team[0];
  if (t === undefined) throw new Error(`team ${teamId} not found`);
  const holidays = await tx.$queryRaw<{ d: string }[]>`
    SELECT to_char(date, 'YYYY-MM-DD') AS d FROM team_holidays WHERE team_id = ${teamId}::uuid`;
  return {
    kind: 'hours',
    timeZone: t.time_zone,
    workdays: t.workdays,
    startMinute: t.work_start_min,
    endMinute: t.work_end_min,
    holidays: holidays.map((h) => h.d),
  };
};

const upsertPendingTimer = async (
  tx: Tx,
  o: {
    key: string;
    kind: 'sla_warning' | 'sla_breach';
    ticketId: string;
    target: string;
    runAt: Date;
    now: Date;
  },
): Promise<void> => {
  // A timer that already fired (status done) is never re-armed or moved: one warning and one breach, ever.
  // A cancelled one (first reply undone, ticket reopened, pause ended) is armed again.
  await tx.$executeRaw`
    INSERT INTO jobs (kind, ref, dedupe_key, run_at, payload, created_at)
    VALUES (${o.kind}, ${o.ticketId}, ${o.key}, ${o.runAt}, ${JSON.stringify({ ticketId: o.ticketId, target: o.target })}::jsonb, ${o.now})
    ON CONFLICT (dedupe_key) DO UPDATE
      SET run_at = EXCLUDED.run_at, status = 'pending', completed_at = NULL
      WHERE jobs.status IN ('pending', 'cancelled')`;
};

const cancelPending = async (
  tx: Tx,
  ticketId: string,
  target: string,
  now: Date,
): Promise<void> => {
  await tx.$executeRaw`
    UPDATE jobs SET status = 'cancelled', completed_at = ${now}
     WHERE status = 'pending' AND kind IN ('sla_warning', 'sla_breach') AND ref = ${ticketId}
       AND dedupe_key LIKE ${`sla:${ticketId}:${target}:%`}`;
};

/**
 * Recomputes all SLA deadlines from the ticket's creation time under its current priority, team calendar,
 * status and pauses, and moves the matching pending timers. Call after anything that changes them.
 */
export const syncSla = async (
  tx: Tx,
  ticketId: string,
  now: Date,
  warningRatio: number,
): Promise<void> => {
  const rows = await tx.$queryRaw<
    {
      team_id: string;
      priority: Priority;
      created_at: Date;
      first_responded_at: Date | null;
      resolved_at: Date | null;
      status: string;
    }[]
  >`SELECT team_id, priority, created_at, first_responded_at, resolved_at, status FROM tickets WHERE id = ${ticketId}::uuid`;
  const t = rows[0];
  if (t === undefined) return;
  const [calendar, pauses] = [
    await loadCalendar(tx, t.team_id),
    await tx.$queryRaw<{ started_at: Date; ended_at: Date | null }[]>`
      SELECT started_at, ended_at FROM sla_pauses WHERE ticket_id = ${ticketId}::uuid ORDER BY started_at`,
  ];
  const computed = computeSlaDeadlines({
    priority: t.priority,
    createdAt: t.created_at,
    calendar,
    pauses: pauses.map((p) => ({ startedAt: p.started_at, endedAt: p.ended_at })),
    warningRatio,
  });
  if (!computed.ok) throw new Error(`SLA calculation failed: ${computed.error}`);
  const d = computed.value;
  const closed = t.status === 'closed';
  const next = closed
    ? null
    : nextDueAt(d, { firstRespondedAt: t.first_responded_at, resolvedAt: t.resolved_at });
  await tx.$executeRaw`
    UPDATE tickets SET first_response_due_at = ${d.firstResponseDueAt}, first_response_warn_at = ${d.firstResponseWarnAt},
           resolution_due_at = ${d.resolutionDueAt}, resolution_warn_at = ${d.resolutionWarnAt},
           sla_paused = ${d.paused}, next_due_at = ${next}
     WHERE id = ${ticketId}::uuid`;

  if (closed || t.first_responded_at !== null)
    await cancelPending(tx, ticketId, 'first_response', now);
  else {
    await upsertPendingTimer(tx, {
      key: `sla:${ticketId}:first_response:warning`,
      kind: 'sla_warning',
      ticketId,
      target: 'first_response',
      runAt: d.firstResponseWarnAt,
      now,
    });
    await upsertPendingTimer(tx, {
      key: `sla:${ticketId}:first_response:breach`,
      kind: 'sla_breach',
      ticketId,
      target: 'first_response',
      runAt: d.firstResponseDueAt,
      now,
    });
  }
  if (
    closed ||
    t.resolved_at !== null ||
    d.paused ||
    d.resolutionDueAt === null ||
    d.resolutionWarnAt === null
  ) {
    await cancelPending(tx, ticketId, 'resolution', now);
  } else {
    await upsertPendingTimer(tx, {
      key: `sla:${ticketId}:resolution:warning`,
      kind: 'sla_warning',
      ticketId,
      target: 'resolution',
      runAt: d.resolutionWarnAt,
      now,
    });
    await upsertPendingTimer(tx, {
      key: `sla:${ticketId}:resolution:breach`,
      kind: 'sla_breach',
      ticketId,
      target: 'resolution',
      runAt: d.resolutionDueAt,
      now,
    });
  }
};
