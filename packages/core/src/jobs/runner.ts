import type { Db } from '../db/client';
import { inTx } from '../db/client';
import type { Ctx, TicketConfig } from '../tickets/types';

export type JobRow = {
  readonly id: number;
  readonly kind: string;
  readonly ref: string;
  readonly dedupeKey: string;
  readonly runAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type HandlerResult = { readonly again?: boolean } | undefined;
export type TxHandler = (c: Ctx, job: JobRow) => Promise<HandlerResult>;

export type RetryPolicy = {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly random: () => number;
};

export type RunOutcome = 'done' | 'again' | 'skipped' | 'retry' | 'dead';

type RawJob = {
  id: bigint;
  kind: string;
  ref: string;
  dedupe_key: string;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

export const toJobRow = (r: RawJob): JobRow => ({
  id: Number(r.id),
  kind: r.kind,
  ref: r.ref,
  dedupeKey: r.dedupe_key,
  runAt: r.run_at,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  payload: r.payload,
});

/** Delay before the next attempt: exponential from `baseMs`, capped, with up to 50% jitter. */
export const backoffMs = (attempts: number, p: RetryPolicy): number =>
  Math.round(Math.min(p.maxMs, p.baseMs * 2 ** attempts) * (0.5 + p.random() / 2));

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Records a failed attempt in its own transaction (the work itself was rolled back): the job gets a later run time,
 * or, when attempts are exhausted, the status `dead`, which the administrator can see and retry.
 */
export const recordJobFailure = async (
  db: Db,
  id: number,
  now: Date,
  error: unknown,
  p: RetryPolicy,
): Promise<'retry' | 'dead'> => {
  const rows = await db.$queryRaw<
    { attempts: number; max_attempts: number }[]
  >`SELECT attempts, max_attempts FROM jobs WHERE id = ${BigInt(id)} AND status = 'pending'`;
  const j = rows[0];
  if (j === undefined) return 'retry';
  const dead = j.attempts + 1 >= j.max_attempts;
  await db.$executeRaw`
    UPDATE jobs SET attempts = attempts + 1, last_error = ${message(error)},
           status = ${dead ? 'dead' : 'pending'}, run_at = ${new Date(now.getTime() + backoffMs(j.attempts, p))}
     WHERE id = ${BigInt(id)} AND status = 'pending'`;
  return dead ? 'dead' : 'retry';
};

/**
 * Runs one durable job. The row is claimed with FOR UPDATE SKIP LOCKED (and must still be pending and due), the domain
 * work and the `done` mark commit together, so a second worker, a duplicate BullMQ message or a crash can never apply
 * the effect twice.
 */
export const runTxJob = async (
  db: Db,
  id: number,
  now: Date,
  cfg: TicketConfig,
  handler: TxHandler,
  p: RetryPolicy,
): Promise<RunOutcome> => {
  try {
    return await inTx(db, async (tx) => {
      const rows = await tx.$queryRaw<RawJob[]>`
        SELECT id, kind, ref, dedupe_key, run_at, attempts, max_attempts, payload FROM jobs
         WHERE id = ${BigInt(id)} AND status = 'pending' AND run_at <= ${now} FOR UPDATE SKIP LOCKED`;
      const row = rows[0];
      if (row === undefined) return 'skipped' as const;
      const result = await handler({ tx, now, cfg }, toJobRow(row));
      if (result?.again === true) {
        await tx.$executeRaw`UPDATE jobs SET run_at = ${now} WHERE id = ${BigInt(id)}`;
        return 'again' as const;
      }
      await tx.$executeRaw`UPDATE jobs SET status = 'done', completed_at = ${now}, attempts = attempts + 1, last_error = NULL WHERE id = ${BigInt(id)}`;
      return 'done' as const;
    });
  } catch (e) {
    return recordJobFailure(db, id, now, e, p);
  }
};
