import { afterAll, describe, expect, it } from 'vitest';
import { cancelJob, requestTeamAssignment, rescheduleJob, upsertJob } from '../src/index';
import { testDb, uniq } from './helpers/db';

const db = testDb();
afterAll(async () => {
  await db.$disconnect();
});

const row = async (key: string) => await db.job.findUniqueOrThrow({ where: { dedupeKey: key } });

describe('durable jobs', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('collapses parallel identical requests into one pending row', async () => {
    const key = uniq('assign');
    await Promise.all(
      Array.from({ length: 20 }, () =>
        upsertJob(db, { kind: 'assign_team', ref: 't', dedupeKey: key, runAt: now, now }),
      ),
    );
    expect(await db.job.count({ where: { dedupeKey: key } })).toBe(1);
  });

  it('re-arms a finished job but never touches a pending one', async () => {
    const key = uniq('rearm');
    await upsertJob(db, { kind: 'assign_team', ref: 't', dedupeKey: key, runAt: now, now });
    const later = new Date(now.getTime() + 60_000);
    await upsertJob(db, { kind: 'assign_team', ref: 't', dedupeKey: key, runAt: later, now });
    expect((await row(key)).runAt).toEqual(now); // pending: unchanged
    await db.job.update({ where: { dedupeKey: key }, data: { status: 'done', attempts: 3 } });
    await upsertJob(db, { kind: 'assign_team', ref: 't', dedupeKey: key, runAt: later, now });
    const r = await row(key);
    expect([r.status, r.attempts, r.runAt]).toEqual(['pending', 0, later]);
  });

  it('reschedules only unfinished timers and cancels pending ones', async () => {
    const key = uniq('sla');
    await upsertJob(db, { kind: 'sla_warning', ref: 't', dedupeKey: key, runAt: now, now });
    const moved = new Date(now.getTime() + 5_000);
    await rescheduleJob(db, key, moved);
    expect((await row(key)).runAt).toEqual(moved);
    await db.job.update({ where: { dedupeKey: key }, data: { status: 'done' } });
    await rescheduleJob(db, key, now);
    expect((await row(key)).runAt).toEqual(moved); // a fired warning is never moved or re-fired
    const other = uniq('sla');
    await upsertJob(db, { kind: 'sla_breach', ref: 't', dedupeKey: other, runAt: now, now });
    await cancelJob(db, other, now);
    expect((await row(other)).status).toBe('cancelled');
  });

  it('requestTeamAssignment uses one key per team', async () => {
    const team = uniq('team');
    await requestTeamAssignment(db, team, now);
    await requestTeamAssignment(db, team, now);
    expect(await db.job.count({ where: { dedupeKey: `assign:${team}` } })).toBe(1);
  });
});
