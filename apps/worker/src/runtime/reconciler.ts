import { dueJobs, ensureDurableJobs, JOB_KINDS, type Db } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export type ReconcilerDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly redis: Redis;
  readonly queues: ReadonlyMap<string, Queue>;
  readonly horizonMs: number;
  readonly generation: () => number;
  /** SLA warning point (share of the target); used to rebuild timer rows that are missing. */
  readonly warningRatio: number;
};

const SLA_CHECK_EVERY_MS = 30_000;

const SENTINEL = 'hd:redis-sentinel';

/**
 * Keeps BullMQ in step with Postgres. BullMQ holds disposable copies of the durable `jobs` rows: this loop re-creates
 * any missing copy (after FLUSHALL, a Redis restart, a lost enqueue or worker downtime) and re-derives the rows that
 * must exist (queued tickets, unsent mail). A copy has a deterministic id, so adding it twice is a no-op.
 */
export const createReconciler = (d: ReconcilerDeps) => {
  const state = {
    known: new Set<string>(),
    generation: Number.NaN,
    lastSlaCheck: Number.NEGATIVE_INFINITY,
  };

  const resetCopies = async (): Promise<void> => {
    state.known.clear();
    for (const q of d.queues.values()) await q.drain(true);
  };

  return {
    /** A finished or failed BullMQ message may be needed again (job still pending in Postgres). */
    forget: (bullId: string): void => {
      state.known.delete(bullId);
    },
    reset: resetCopies,
    tick: async (): Promise<number> => {
      const now = d.clock.now();
      const gen = d.generation();
      if (gen !== state.generation) {
        // The shared test clock moved: delays computed under the old time are wrong, so rebuild every copy.
        if (!Number.isNaN(state.generation)) await resetCopies();
        state.generation = gen;
      }
      const fresh = await d.redis.set(SENTINEL, '1', 'NX');
      if (fresh === 'OK') state.known.clear(); // Redis was empty: nothing we added before is still there
      // The SLA timer check is wider than the others, so it runs every 30 s instead of on every tick.
      const slaDue = now.getTime() - state.lastSlaCheck >= SLA_CHECK_EVERY_MS || fresh === 'OK';
      if (slaDue) state.lastSlaCheck = now.getTime();
      await ensureDurableJobs(
        d.db,
        now,
        slaDue ? { slaTimers: { warningRatio: d.warningRatio } } : {},
      );
      const due = await dueJobs(d.db, now, d.horizonMs, 5000);
      let added = 0;
      for (const j of due) {
        const bullId = `j${j.id}_${j.attempts}_${gen}`;
        if (state.known.has(bullId)) continue;
        const queue = d.queues.get(j.kind);
        if (queue === undefined) continue;
        await queue.add(
          j.kind,
          { jobId: j.id },
          {
            jobId: bullId,
            delay: Math.max(0, j.runAt.getTime() - now.getTime()),
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 1,
          },
        );
        state.known.add(bullId);
        added += 1;
      }
      return added;
    },
  };
};

export const queueNames = JOB_KINDS;
