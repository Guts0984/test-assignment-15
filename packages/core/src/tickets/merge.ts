import { ok, type Result } from '@helpdesk/shared';
import { cancelJob, requestTeamAssignment } from '../jobs/jobs';
import { syncSla } from './sla-sync';
import { history, lockTickets, touch } from './store';
import { fail, type ActorRef, type Ctx, type TicketError } from './types';

export type MergeResult = { readonly mainTicketId: string; readonly movedMessages: number };

/**
 * Merges `sourceId` (the duplicate) into `targetId` (the main ticket). Both rows are locked in id order, so
 * simultaneous A->B and B->A serialize: the second sees the first's result and is refused.
 * The correspondence moves to the main ticket, the duplicate is closed with a link, its customer links are revoked.
 */
export const mergeTickets = async (
  c: Ctx,
  i: { sourceId: string; targetId: string; actor: ActorRef },
): Promise<Result<MergeResult, TicketError>> => {
  if (i.sourceId === i.targetId)
    return fail('TICKETS_NOT_MERGEABLE', 'A ticket cannot be merged into itself');
  const locked = await lockTickets(c.tx, [i.sourceId, i.targetId]);
  const source = locked.find((t) => t.id === i.sourceId);
  const target = locked.find((t) => t.id === i.targetId);
  if (source === undefined || target === undefined) return fail('NOT_FOUND', 'Ticket not found');
  if (source.mergedIntoId !== null || target.mergedIntoId !== null)
    return fail('TICKET_ALREADY_MERGED', 'A merged ticket cannot be merged again');
  if (source.customerId !== target.customerId)
    return fail('TICKETS_NOT_MERGEABLE', 'Only tickets of the same customer can be merged');
  if (source.status === 'closed' || target.status === 'closed')
    return fail('TICKETS_NOT_MERGEABLE', 'Closed tickets cannot be merged');

  const moved = await c.tx.$executeRaw`
    WITH base AS (SELECT message_seq AS base_seq FROM tickets WHERE id = ${target.id}::uuid),
         ordered AS (
           SELECT m.id, row_number() OVER (ORDER BY m.created_at, m.seq) AS rn FROM messages m WHERE m.ticket_id = ${source.id}::uuid
         )
    UPDATE messages m SET ticket_id = ${target.id}::uuid, seq = (SELECT base_seq FROM base) + o.rn,
           origin_ticket_id = ${source.id}::uuid
      FROM ordered o WHERE m.id = o.id`;
  await c.tx
    .$executeRaw`UPDATE tickets SET message_seq = message_seq + ${moved} WHERE id = ${target.id}::uuid`;
  await c.tx
    .$executeRaw`UPDATE outbound_emails SET ticket_id = ${target.id}::uuid WHERE ticket_id = ${source.id}::uuid`;
  await c.tx
    .$executeRaw`UPDATE sla_pauses SET ended_at = ${c.now} WHERE ticket_id = ${source.id}::uuid AND ended_at IS NULL`;
  await c.tx.$executeRaw`
    UPDATE tickets SET status = 'closed', closed_at = ${c.now}, assignee_id = NULL, merged_into_id = ${target.id}::uuid, next_due_at = NULL,
           queued_at = NULL
     WHERE id = ${source.id}::uuid`;
  await c.tx
    .$executeRaw`UPDATE ticket_access_tokens SET revoked_at = ${c.now} WHERE ticket_id = ${source.id}::uuid AND revoked_at IS NULL`;
  await c.tx
    .$executeRaw`UPDATE surveys SET expires_at = LEAST(expires_at, ${c.now}) WHERE ticket_id = ${source.id}::uuid AND rating IS NULL`;
  await cancelJob(c.tx, `auto_close:${source.id}`, c.now);
  await syncSla(c.tx, source.id, c.now, c.cfg.warningRatio);
  // The main ticket keeps its own SLA; the customer's activity from the duplicate refreshes the last-message markers.
  await c.tx.$executeRaw`
    UPDATE tickets t SET
      last_customer_msg_at = GREATEST(t.last_customer_msg_at, (SELECT max(created_at) FROM messages WHERE ticket_id = t.id AND direction = 'inbound')),
      last_public_reply_at = (SELECT max(created_at) FROM messages WHERE ticket_id = t.id AND direction = 'outbound' AND kind = 'public' AND cancelled_at IS NULL)
     WHERE t.id = ${target.id}::uuid`;
  await history(c.tx, source.id, 'merged', i.actor, c.now, {
    intoTicketId: target.id,
    intoNumber: target.number,
    movedMessages: moved,
  });
  await history(c.tx, target.id, 'merged_in', i.actor, c.now, {
    fromTicketId: source.id,
    fromNumber: source.number,
    movedMessages: moved,
  });
  await touch(c.tx, source.id, c.now);
  await touch(c.tx, target.id, c.now);
  if (source.assigneeId !== null) await requestTeamAssignment(c.tx, source.teamId, c.now);
  return ok({ mainTicketId: target.id, movedMessages: moved });
};
