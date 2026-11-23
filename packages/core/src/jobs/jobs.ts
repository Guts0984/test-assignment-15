import type { Queryable } from '../db/client';

export const JOB_KINDS = [
  'inbound_process',
  'assign_team',
  'sla_warning',
  'sla_breach',
  'outbound_send',
  'auto_close',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type NewJob = {
  readonly kind: JobKind;
  readonly ref: string;
  /** One row per key. Re-requesting a finished job with the same key re-arms it. */
  readonly dedupeKey: string;
  readonly runAt: Date;
  readonly now: Date;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
  /** False for the reconciler: a job that ran out of attempts stays dead until an administrator or a user action re-arms it. */
  readonly rearmDead?: boolean;
};

/**
 * Durable "do this at that time" record (the source of truth for timers). Inserting the same key twice
 * is harmless; if the earlier run already completed, the job is armed again for `runAt`.
 */
export const upsertJob = async (db: Queryable, j: NewJob): Promise<void> => {
  await db.$executeRaw`
    INSERT INTO jobs (kind, ref, dedupe_key, run_at, payload, max_attempts, created_at)
    VALUES (${j.kind}, ${j.ref}, ${j.dedupeKey}, ${j.runAt}, ${JSON.stringify(j.payload ?? {})}::jsonb,
            ${j.maxAttempts ?? 8}, ${j.now})
    ON CONFLICT (dedupe_key) DO UPDATE
      SET status = 'pending', run_at = EXCLUDED.run_at, attempts = 0, last_error = NULL, completed_at = NULL
      WHERE jobs.status IN ('done', 'cancelled') OR (jobs.status = 'dead' AND ${j.rearmDead ?? true})`;
};

/** Asks for a team assignment run; many requests collapse into one pending job. */
export const requestTeamAssignment = (db: Queryable, teamId: string, now: Date): Promise<void> =>
  upsertJob(db, {
    kind: 'assign_team',
    ref: teamId,
    dedupeKey: `assign:${teamId}`,
    runAt: now,
    now,
  });

export const requestTeamAssignments = async (
  db: Queryable,
  teamIds: readonly string[],
  now: Date,
): Promise<void> => {
  for (const id of teamIds) await requestTeamAssignment(db, id, now);
};

/** Moves an unfinished timer (priority/team change); finished ones are never re-fired. */
export const rescheduleJob = async (
  db: Queryable,
  dedupeKey: string,
  runAt: Date,
): Promise<void> => {
  await db.$executeRaw`UPDATE jobs SET run_at = ${runAt} WHERE dedupe_key = ${dedupeKey} AND status = 'pending'`;
};

export const cancelJob = async (db: Queryable, dedupeKey: string, now: Date): Promise<void> => {
  await db.$executeRaw`UPDATE jobs SET status = 'cancelled', completed_at = ${now} WHERE dedupe_key = ${dedupeKey} AND status = 'pending'`;
};
