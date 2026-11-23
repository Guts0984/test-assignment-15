import {
  canTransition,
  ok,
  pausesSla,
  type Priority,
  type Result,
  type TicketStatus,
} from '@helpdesk/shared';
import { collectorOf, notifyPreviousOwner } from '../realtime/collector';
import { cancelJob, requestTeamAssignment, upsertJob } from '../jobs/jobs';
import { closeResolvedTicket } from './close';
import { syncSla } from './sla-sync';
import { getTicket, history, touch } from './store';
import { fail, type ActorRef, type Ctx, type TicketError } from './types';

const HOUR_MS = 3_600_000;

/** Status change with its side effects: SLA pause, resolved/closed bookkeeping, auto-close timer, slot release. */
export const changeStatus = async (
  c: Ctx,
  i: { ticketId: string; actor: ActorRef; to: TicketStatus },
): Promise<Result<{ from: TicketStatus; to: TicketStatus }, TicketError>> => {
  const t = await getTicket(c.tx, i.ticketId, true);
  if (t === null) return fail('NOT_FOUND', 'Ticket not found');
  const from = t.status as TicketStatus;
  if (!canTransition(from, i.to, i.actor.kind)) {
    return fail('INVALID_STATUS_TRANSITION', `Cannot move a ticket from ${from} to ${i.to}`, {
      from,
      to: i.to,
    });
  }
  if (i.to === 'closed') {
    await closeResolvedTicket(c, t.id, i.actor);
    return ok({ from, to: i.to });
  }
  if (pausesSla(i.to)) {
    await c.tx
      .$executeRaw`INSERT INTO sla_pauses (ticket_id, started_at) VALUES (${t.id}::uuid, ${c.now})`;
  } else if (pausesSla(from)) {
    await c.tx
      .$executeRaw`UPDATE sla_pauses SET ended_at = ${c.now} WHERE ticket_id = ${t.id}::uuid AND ended_at IS NULL`;
  }
  if (i.to === 'resolved') {
    await c.tx
      .$executeRaw`UPDATE tickets SET status = 'resolved', resolved_at = ${c.now} WHERE id = ${t.id}::uuid`;
    await upsertJob(c.tx, {
      kind: 'auto_close',
      ref: t.id,
      dedupeKey: `auto_close:${t.id}`,
      now: c.now,
      runAt: new Date(c.now.getTime() + c.cfg.autoCloseHours * HOUR_MS),
      payload: { ticketId: t.id },
    });
  } else {
    await c.tx
      .$executeRaw`UPDATE tickets SET status = ${i.to}, resolved_at = NULL WHERE id = ${t.id}::uuid`;
    if (from === 'resolved') await cancelJob(c.tx, `auto_close:${t.id}`, c.now);
  }
  await history(c.tx, t.id, 'status_changed', i.actor, c.now, { from, to: i.to });
  await syncSla(c.tx, t.id, c.now, c.cfg.warningRatio);
  await touch(c.tx, t.id, c.now);
  // A resolved ticket frees a slot; the next queued ticket of the team is assigned right away.
  if (t.assigneeId !== null && i.to === 'resolved')
    await requestTeamAssignment(c.tx, t.teamId, c.now);
  return ok({ from, to: i.to });
};

export const changePriority = async (
  c: Ctx,
  i: { ticketId: string; actor: ActorRef; priority: Priority },
): Promise<Result<{ from: string; to: Priority }, TicketError>> => {
  const t = await getTicket(c.tx, i.ticketId, true);
  if (t === null) return fail('NOT_FOUND', 'Ticket not found');
  if (t.status === 'closed')
    return fail('INVALID_STATUS_TRANSITION', 'A closed ticket cannot be changed');
  await c.tx.$executeRaw`UPDATE tickets SET priority = ${i.priority} WHERE id = ${t.id}::uuid`;
  await history(c.tx, t.id, 'priority_changed', i.actor, c.now, {
    from: t.priority,
    to: i.priority,
  });
  await syncSla(c.tx, t.id, c.now, c.cfg.warningRatio);
  await touch(c.tx, t.id, c.now);
  return ok({ from: t.priority, to: i.priority });
};

/** Moves the ticket to another team: it loses its owner, joins the new team queue and gets that team's calendar. */
export const changeTeam = async (
  c: Ctx,
  i: { ticketId: string; actor: ActorRef; teamId: string },
): Promise<Result<{ from: string; to: string }, TicketError>> => {
  const t = await getTicket(c.tx, i.ticketId, true);
  if (t === null) return fail('NOT_FOUND', 'Ticket not found');
  if (t.status === 'closed')
    return fail('INVALID_STATUS_TRANSITION', 'A closed ticket cannot be changed');
  const exists = await c.tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM teams WHERE id = ${i.teamId}::uuid`;
  if (exists.length === 0) return fail('NOT_FOUND', 'Team not found');
  if (t.teamId === i.teamId) return ok({ from: t.teamId, to: i.teamId });
  await c.tx.$executeRaw`
    UPDATE tickets SET team_id = ${i.teamId}::uuid, assignee_id = NULL, queued_at = ${c.now} WHERE id = ${t.id}::uuid`;
  await history(c.tx, t.id, 'team_changed', i.actor, c.now, {
    from: t.teamId,
    to: i.teamId,
    previousAssigneeId: t.assigneeId,
  });
  collectorOf(c.tx).revokeStaff.add(t.id);
  notifyPreviousOwner(c.tx, t.id, t.assigneeId);
  await syncSla(c.tx, t.id, c.now, c.cfg.warningRatio);
  await touch(c.tx, t.id, c.now);
  await requestTeamAssignment(c.tx, i.teamId, c.now);
  if (t.assigneeId !== null) await requestTeamAssignment(c.tx, t.teamId, c.now);
  return ok({ from: t.teamId, to: i.teamId });
};

const isTeamAgent = async (c: Ctx, userId: string, teamId: string): Promise<boolean> => {
  const rows = await c.tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ${userId}::uuid AND m.team_id = ${teamId}::uuid AND m.role = 'agent' AND u.is_active`;
  return rows.length > 0;
};

/**
 * Hands the ticket to a colleague (or, for leads, reassigns it). The agent-load trigger rejects a target at their
 * limit; the ticket row lock makes this and auto-assignment / "take it" strictly sequential.
 */
export const transferTicket = async (
  c: Ctx,
  i: { ticketId: string; actor: ActorRef; toUserId: string; leadOverride: boolean },
): Promise<Result<{ from: string | null; to: string }, TicketError>> => {
  const t = await getTicket(c.tx, i.ticketId, true);
  if (t === null) return fail('NOT_FOUND', 'Ticket not found');
  if (t.status === 'closed' || t.status === 'resolved')
    return fail('INVALID_STATUS_TRANSITION', 'Only open tickets can be transferred');
  if (!i.leadOverride && t.assigneeId !== i.actor.userId)
    return fail('FORBIDDEN', 'Only the owner can transfer this ticket');
  if (!(await isTeamAgent(c, i.toUserId, t.teamId)))
    return fail('NOT_FOUND', 'Target agent is not available in this team');
  if (t.assigneeId === i.toUserId) return ok({ from: t.assigneeId, to: i.toUserId });
  await c.tx
    .$executeRaw`UPDATE tickets SET assignee_id = ${i.toUserId}::uuid, queued_at = NULL WHERE id = ${t.id}::uuid`;
  await c.tx
    .$executeRaw`UPDATE users SET last_assigned_at = ${c.now} WHERE id = ${i.toUserId}::uuid`;
  await history(c.tx, t.id, 'transferred', i.actor, c.now, { from: t.assigneeId, to: i.toUserId });
  notifyPreviousOwner(c.tx, t.id, t.assigneeId);
  notifyPreviousOwner(c.tx, t.id, t.assigneeId);
  await touch(c.tx, t.id, c.now);
  if (t.assigneeId !== null) await requestTeamAssignment(c.tx, t.teamId, c.now);
  return ok({ from: t.assigneeId, to: i.toUserId });
};

/** "Take it": only an unassigned ticket can be taken, so racing with auto-assignment yields one owner. */
export const takeTicket = async (
  c: Ctx,
  i: { ticketId: string; actor: ActorRef },
): Promise<Result<{ taken: true }, TicketError>> => {
  const t = await getTicket(c.tx, i.ticketId, true);
  if (t === null) return fail('NOT_FOUND', 'Ticket not found');
  if (t.status === 'closed' || t.status === 'resolved')
    return fail('INVALID_STATUS_TRANSITION', 'Only open tickets can be taken');
  if (t.assigneeId !== null)
    return fail('TICKET_ALREADY_ASSIGNED', 'The ticket already has an owner');
  const userId = i.actor.userId;
  if (userId === null || !(await isTeamAgent(c, userId, t.teamId)))
    return fail('FORBIDDEN', 'Only agents of the team can take tickets');
  await c.tx
    .$executeRaw`UPDATE tickets SET assignee_id = ${userId}::uuid, queued_at = NULL WHERE id = ${t.id}::uuid`;
  await c.tx.$executeRaw`UPDATE users SET last_assigned_at = ${c.now} WHERE id = ${userId}::uuid`;
  await history(c.tx, t.id, 'taken', i.actor, c.now, { by: userId });
  await touch(c.tx, t.id, c.now);
  return ok({ taken: true });
};
