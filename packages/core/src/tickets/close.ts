import { cancelJob, requestTeamAssignment } from '../jobs/jobs';
import { createSurveyFor } from './survey';
import { history, getTicket, touch } from './store';
import { syncSla } from './sla-sync';
import type { ActorRef, Ctx } from './types';

/**
 * Resolved -> closed (automatic after 3 days or manual by a lead): closes the ticket, stops its timers,
 * creates the one survey and queues the survey email.
 */
export const closeResolvedTicket = async (
  c: Ctx,
  ticketId: string,
  actor: ActorRef,
): Promise<void> => {
  const t = await getTicket(c.tx, ticketId, true);
  if (t === null || t.status === 'closed') return;
  await c.tx
    .$executeRaw`UPDATE tickets SET status = 'closed', closed_at = ${c.now} WHERE id = ${t.id}::uuid`;
  await c.tx
    .$executeRaw`UPDATE sla_pauses SET ended_at = ${c.now} WHERE ticket_id = ${t.id}::uuid AND ended_at IS NULL`;
  await cancelJob(c.tx, `auto_close:${t.id}`, c.now);
  await history(c.tx, t.id, 'status_changed', actor, c.now, { from: t.status, to: 'closed' });
  await syncSla(c.tx, t.id, c.now, c.cfg.warningRatio);
  await createSurveyFor(c, t.id, t.number, t.subject, t.customerId);
  await touch(c.tx, t.id, c.now);
  if (t.assigneeId !== null) await requestTeamAssignment(c.tx, t.teamId, c.now);
};
