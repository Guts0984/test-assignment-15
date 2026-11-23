import type { Db } from '../db/client';
import { upsertJob } from './jobs';

export type DueJob = {
  readonly id: number;
  readonly kind: string;
  readonly runAt: Date;
  readonly attempts: number;
};

/** Pending jobs that are due within the horizon, earliest first. Postgres is the truth; BullMQ only holds copies. */
export const dueJobs = async (
  db: Db,
  now: Date,
  horizonMs: number,
  limit: number,
): Promise<DueJob[]> => {
  const rows = await db.$queryRaw<{ id: bigint; kind: string; run_at: Date; attempts: number }[]>`
    SELECT id, kind, run_at, attempts FROM jobs
     WHERE status = 'pending' AND run_at <= ${new Date(now.getTime() + horizonMs)}
     ORDER BY run_at, id LIMIT ${limit}`;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    runAt: r.run_at,
    attempts: r.attempts,
  }));
};

/**
 * Makes sure every action that should be pending has a durable job row, whatever happened before (Redis loss,
 * a crash between a commit and the enqueue, an old row marked done): queued tickets with free agents, unprocessed
 * inbound mail, and outbound emails waiting to be sent.
 */
export const ensureDurableJobs = async (db: Db, now: Date): Promise<number> => {
  let touched = 0;
  const teams = await db.$queryRaw<{ team_id: string }[]>`
    SELECT DISTINCT t.team_id FROM tickets t
     WHERE t.assignee_id IS NULL AND t.status IN ('new', 'open', 'waiting_customer', 'on_hold')
       AND EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
                    WHERE m.team_id = t.team_id AND m.role = 'agent' AND u.is_active AND u.on_shift AND u.open_count < u.ticket_limit)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'assign:' || t.team_id::text AND j.status = 'pending')`;
  for (const t of teams) {
    await upsertJob(db, {
      kind: 'assign_team',
      ref: t.team_id,
      dedupeKey: `assign:${t.team_id}`,
      runAt: now,
      now,
    });
    touched += 1;
  }
  const inbound = await db.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM inbound_messages i
     WHERE i.state = 'pending' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'inbound:' || i.id::text AND j.status = 'pending')
     LIMIT 1000`;
  for (const i of inbound) {
    await upsertJob(db, {
      kind: 'inbound_process',
      ref: i.id,
      dedupeKey: `inbound:${i.id}`,
      runAt: now,
      now,
      payload: { inboundId: i.id },
    });
    touched += 1;
  }
  const outbound = await db.$queryRaw<{ id: string; send_after: Date }[]>`
    SELECT o.id, o.send_after FROM outbound_emails o
     WHERE o.state IN ('scheduled', 'sending') AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'outbound:' || o.id::text AND j.status = 'pending')
     LIMIT 1000`;
  for (const o of outbound) {
    await upsertJob(db, {
      kind: 'outbound_send',
      ref: o.id,
      dedupeKey: `outbound:${o.id}`,
      runAt: o.send_after,
      now,
      payload: { outboundId: o.id },
    });
    touched += 1;
  }
  return touched;
};
