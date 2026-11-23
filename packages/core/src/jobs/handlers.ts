import { systemActor } from './system-actor';
import { assignQueuedTickets } from './assignment';
import { fireSlaEvent, type SlaTarget } from './sla-events';
import { closeResolvedTicket } from '../tickets/close';
import { processInboundTx } from '../tickets/ingest';
import type { TxHandler } from './runner';

const ASSIGN_BATCH = 200;

/** Handlers for every job kind that is a plain database transaction (outbound email has its own state machine). */
export const txHandlers: Readonly<Record<string, TxHandler>> = {
  inbound_process: async (c, job) => {
    await processInboundTx(c, String(job.payload['inboundId'] ?? job.ref));
    return undefined;
  },
  assign_team: async (c, job) => {
    const r = await assignQueuedTickets(c.tx, job.ref, c.now, ASSIGN_BATCH);
    return r.more ? { again: true } : undefined;
  },
  sla_warning: async (c, job) => {
    await fireSlaEvent(c.tx, {
      ticketId: job.ref,
      target: String(job.payload['target']) as SlaTarget,
      event: 'warning',
      now: c.now,
    });
    return undefined;
  },
  sla_breach: async (c, job) => {
    await fireSlaEvent(c.tx, {
      ticketId: job.ref,
      target: String(job.payload['target']) as SlaTarget,
      event: 'breach',
      now: c.now,
    });
    return undefined;
  },
  auto_close: async (c, job) => {
    const rows = await c.tx.$queryRaw<
      { status: string; resolved_at: Date | null }[]
    >`SELECT status, resolved_at FROM tickets WHERE id = ${job.ref}::uuid FOR UPDATE`;
    const t = rows[0];
    const dueAt =
      t?.resolved_at === null || t === undefined
        ? null
        : t.resolved_at.getTime() + c.cfg.autoCloseHours * 3_600_000;
    if (t?.status === 'resolved' && dueAt !== null && dueAt <= c.now.getTime())
      await closeResolvedTicket(c, job.ref, systemActor);
    return undefined;
  },
};
