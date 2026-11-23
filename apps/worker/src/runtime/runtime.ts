import {
  createDb,
  createDbClock,
  type Db,
  type DbClock,
  type RetryPolicy,
  type TicketConfig,
} from '@helpdesk/core';
import { systemClock, type Clock } from '@helpdesk/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createSmtpSender } from '../infra/smtp-sender';
import { createProcessor } from './processor';
import { createReconciler, queueNames } from './reconciler';

export type RuntimeConfig = {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly queuePrefix: string;
  readonly testClock: boolean;
  readonly smtp: { readonly host: string; readonly port: number; readonly fromName: string };
  readonly mailDomain: string;
  readonly concurrency: number;
  readonly reconcileIntervalMs: number;
  readonly reconcileHorizonMs: number;
  readonly jobMaxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly outboundLeaseMs: number;
  readonly ticket: TicketConfig;
};

export type WorkerRuntime = {
  readonly db: Db;
  readonly clock: Clock;
  readonly dbClock: DbClock | null;
  readonly reconcileNow: () => Promise<number>;
  readonly stop: () => Promise<void>;
};

/** Starts one worker copy: BullMQ workers for every job kind plus the reconciler loop. */
export const startWorkerRuntime = async (c: RuntimeConfig): Promise<WorkerRuntime> => {
  const db = createDb(c.databaseUrl);
  const dbClock = c.testClock
    ? await createDbClock({ base: systemClock, db, listenUrl: c.databaseUrl })
    : null;
  const clock: Clock = dbClock ?? systemClock;
  const redisOpts = { maxRetriesPerRequest: null } as const;
  const redis = new Redis(c.redisUrl, redisOpts);
  const queues = new Map(
    queueNames.map((k) => [
      k,
      new Queue(k, { connection: new Redis(c.redisUrl, redisOpts), prefix: c.queuePrefix }),
    ]),
  );
  const sender = createSmtpSender(c.smtp);
  const policy: RetryPolicy = {
    baseMs: c.backoffBaseMs,
    maxMs: c.backoffMaxMs,
    random: Math.random,
  };
  const process = createProcessor({
    db,
    clock,
    cfg: c.ticket,
    policy,
    send: sender.send,
    leaseMs: c.outboundLeaseMs,
    maxAttempts: c.jobMaxAttempts,
    defaultFrom: `support@${c.mailDomain}`,
  });
  const reconciler = createReconciler({
    db,
    clock,
    redis,
    queues,
    horizonMs: c.reconcileHorizonMs,
    generation: () => dbClock?.generation() ?? 0,
  });

  const workers = queueNames.map((kind) => {
    const w = new Worker(
      kind,
      async (job) => {
        await process(kind, Number((job.data as { jobId: number }).jobId));
      },
      {
        connection: new Redis(c.redisUrl, redisOpts),
        prefix: c.queuePrefix,
        concurrency: c.concurrency,
        stalledInterval: 5000,
        lockDuration: 10_000,
        maxStalledCount: 10,
      },
    );
    const forget = (job?: { id?: string }): void => {
      if (job?.id !== undefined) reconciler.forget(job.id);
    };
    w.on('completed', forget);
    w.on('failed', forget);
    w.on('error', () => undefined);
    return w;
  });

  const state = { stopped: false, ticking: false };
  const tick = async (): Promise<number> => {
    if (state.ticking) return 0;
    state.ticking = true;
    try {
      return await reconciler.tick();
    } catch {
      return 0; // Redis or Postgres hiccup: the next tick repairs it
    } finally {
      state.ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), c.reconcileIntervalMs);
  void tick();

  return {
    db,
    clock,
    dbClock,
    reconcileNow: tick,
    stop: async () => {
      state.stopped = true;
      clearInterval(timer);
      await Promise.all(workers.map((w) => w.close(true)));
      await Promise.all([...queues.values()].map((q) => q.close()));
      sender.close();
      await dbClock?.stop();
      await db.$disconnect();
      redis.disconnect();
    },
  };
};
