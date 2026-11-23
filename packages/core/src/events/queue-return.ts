import type { Tx } from '../db/client';
import { appendTicketEvent } from './ticket-events';

export type ReturnToQueueInput = {
  readonly agentId: string;
  /** Only tickets of this team; omitted = every team. */
  readonly teamId?: string;
  /** Only tickets without a public reply after this instant (shift-off rule); omitted = all of them. */
  readonly noReplySince?: Date;
  readonly reason: 'shift_off' | 'deactivated' | 'removed_from_team';
  readonly now: Date;
};

/**
 * Unassigns the agent's active tickets and puts them back in the team queue, recording history.
 * Returns the affected ticket ids and the teams that now need an assignment run.
 */
export const returnAgentTicketsToQueue = async (
  tx: Tx,
  i: ReturnToQueueInput,
): Promise<{ readonly ticketIds: readonly string[]; readonly teamIds: readonly string[] }> => {
  const rows = await tx.$queryRaw<{ id: string; team_id: string }[]>`
    SELECT id, team_id FROM tickets
     WHERE assignee_id = ${i.agentId}::uuid
       AND status IN ('new', 'open', 'waiting_customer', 'on_hold')
       AND (${i.teamId ?? null}::uuid IS NULL OR team_id = ${i.teamId ?? null}::uuid)
       AND (${i.noReplySince ?? null}::timestamptz IS NULL
            OR last_public_reply_at IS NULL OR last_public_reply_at < ${i.noReplySince ?? null}::timestamptz)
     ORDER BY id
       FOR UPDATE`;
  if (rows.length === 0) return { ticketIds: [], teamIds: [] };
  const ids = rows.map((r) => r.id);
  await tx.$executeRaw`
    UPDATE tickets SET assignee_id = NULL, queued_at = ${i.now}, version = version + 1, updated_at = ${i.now}
     WHERE id = ANY(${ids}::uuid[])`;
  for (const r of rows) {
    await appendTicketEvent(tx, {
      ticketId: r.id,
      type: 'returned_to_queue',
      actorKind: 'system',
      data: { fromAgentId: i.agentId, reason: i.reason },
      at: i.now,
    });
  }
  return { ticketIds: ids, teamIds: [...new Set(rows.map((r) => r.team_id))] };
};
