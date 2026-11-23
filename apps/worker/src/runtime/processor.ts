import {
  runOutboundJob,
  runTxJob,
  txHandlers,
  type Db,
  type RetryPolicy,
  type RunOutcome,
  type SendFn,
  type TicketConfig,
} from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';

export type ProcessorDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly cfg: TicketConfig;
  readonly policy: RetryPolicy;
  readonly send: SendFn;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly defaultFrom: string;
};

/** What a BullMQ message does: look the durable job up and run it. Everything that matters happens in Postgres. */
export const createProcessor =
  (d: ProcessorDeps) =>
  async (kind: string, jobId: number): Promise<RunOutcome> => {
    const now = d.clock.now();
    if (kind === 'outbound_send') {
      const rows = await d.db.$queryRaw<
        { ref: string }[]
      >`SELECT ref FROM jobs WHERE id = ${BigInt(jobId)} AND status = 'pending'`;
      const ref = rows[0]?.ref;
      if (ref === undefined) return 'skipped';
      return runOutboundJob(d.db, {
        jobId,
        outboundId: ref,
        now,
        leaseMs: d.leaseMs,
        maxAttempts: d.maxAttempts,
        defaultFrom: d.defaultFrom,
        send: d.send,
        policy: d.policy,
      });
    }
    const handler = txHandlers[kind];
    if (handler === undefined) return 'skipped';
    return runTxJob(d.db, jobId, now, d.cfg, handler, d.policy);
  };
