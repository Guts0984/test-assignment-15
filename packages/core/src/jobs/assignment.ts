import { selectAgent, type AgentCandidate, type Language } from '@helpdesk/shared';
import type { Tx } from '../db/client';
import { appendTicketEvent } from '../events/ticket-events';

type CandidateRow = {
  id: string;
  role: string;
  is_active: boolean;
  on_shift: boolean;
  open_count: number;
  ticket_limit: number;
  last_assigned_at: Date | null;
  languages: string[];
};

const loadCandidates = async (tx: Tx, teamId: string): Promise<AgentCandidate[]> => {
  const rows = await tx.$queryRaw<CandidateRow[]>`
    SELECT u.id, m.role, u.is_active, u.on_shift, u.open_count, u.ticket_limit, u.last_assigned_at, u.languages
      FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ${teamId}::uuid`;
  return rows.map((r) => ({
    userId: r.id,
    role: r.role as 'agent' | 'lead',
    active: r.is_active,
    onShift: r.on_shift,
    openCount: r.open_count,
    limit: r.ticket_limit,
    lastAssignedAt: r.last_assigned_at,
    languages: r.languages as Language[],
  }));
};

export type AssignmentRun = { readonly assigned: number; readonly more: boolean };

/**
 * Hands queued tickets of a team to agents, one by one, most urgent first. One run per team at a time (advisory lock);
 * each ticket row is locked (SKIP LOCKED) so a simultaneous "take it" or transfer simply wins that ticket.
 * The limit is enforced by the database trigger, so even a stale candidate list can never exceed it.
 */
export const assignQueuedTickets = async (
  tx: Tx,
  teamId: string,
  now: Date,
  batch: number,
): Promise<AssignmentRun> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assign:${teamId}`}))`;
  let assigned = 0;
  const candidates = await loadCandidates(tx, teamId);
  const load = new Map(candidates.map((c) => [c.userId, c]));
  while (assigned < batch) {
    const rows = await tx.$queryRaw<{ id: string; language: string }[]>`
      SELECT id, language FROM tickets
       WHERE team_id = ${teamId}::uuid AND assignee_id IS NULL AND status IN ('new', 'open', 'waiting_customer', 'on_hold')
       ORDER BY next_due_at NULLS LAST, created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const t = rows[0];
    if (t === undefined) return { assigned, more: false };
    const pick = selectAgent([...load.values()], t.language as Language);
    if (pick === null) return { assigned, more: false };
    await tx.$executeRaw`UPDATE tickets SET assignee_id = ${pick}::uuid, queued_at = NULL, version = version + 1, updated_at = ${now} WHERE id = ${t.id}::uuid`;
    await tx.$executeRaw`UPDATE users SET last_assigned_at = ${now} WHERE id = ${pick}::uuid`;
    await appendTicketEvent(tx, {
      ticketId: t.id,
      type: 'assigned',
      actorKind: 'system',
      data: { assigneeId: pick, auto: true },
      at: now,
    });
    const c = load.get(pick);
    if (c !== undefined) load.set(pick, { ...c, openCount: c.openCount + 1, lastAssignedAt: now });
    assigned += 1;
  }
  return { assigned, more: true };
};
