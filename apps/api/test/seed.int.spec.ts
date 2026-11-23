import { systemClock } from '@helpdesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/infra/password';
import { SEED_SIZES } from '../src/seed/profiles';
import { runSeed, type SeedOutcome } from '../src/seed/seed-run';
import { createIsolatedDb, type IsolatedDb } from './helpers/isolated-db';

const PASSWORD = 'Passw0rd-demo!';
let iso: IsolatedDb;
let firstOutcome: SeedOutcome;
let seededAt: Date;

const n = async (sql: string): Promise<number> => {
  const rows = await iso.db.$queryRawUnsafe<{ n: bigint }[]>(sql);
  return Number(rows[0]?.n ?? 0);
};

beforeAll(async () => {
  iso = await createIsolatedDb('seed');
  const passwordHash = await hashPassword(PASSWORD, { memoryKiB: 4096, timeCost: 1 });
  seededAt = new Date();
  firstOutcome = await runSeed(iso.db, {
    profile: 'small',
    randomSeed: 42,
    reset: false,
    passwordHash,
    clock: systemClock,
    warningRatio: 0.8,
  });
});

afterAll(async () => {
  await iso.drop();
});

describe('small seed profile', () => {
  const sizes = SEED_SIZES.small;

  it('creates 4 teams in 2 time zones with holidays and mailboxes', async () => {
    expect(firstOutcome.status).toBe('seeded');
    expect(await n('SELECT count(*) AS n FROM teams')).toBe(4);
    expect(await n('SELECT count(DISTINCT time_zone) AS n FROM teams')).toBe(2);
    expect(await n('SELECT count(*) AS n FROM mailboxes')).toBe(4);
    expect(
      await n(
        "SELECT count(*) AS n FROM team_holidays WHERE date BETWEEN '2026-01-01' AND '2026-12-31'",
      ),
    ).toBeGreaterThan(30);
  });

  it('creates 80 agents, 4 leads and one admin with working logins', async () => {
    expect(await n("SELECT count(*) AS n FROM team_members WHERE role = 'agent'")).toBe(80);
    expect(await n("SELECT count(*) AS n FROM team_members WHERE role = 'lead'")).toBe(4);
    expect(await n("SELECT count(*) AS n FROM users WHERE role = 'admin'")).toBe(1);
    const agent = await iso.db.user.findUniqueOrThrow({
      where: { email: 'agent01@helpdesk.test' },
    });
    expect(await verifyPassword(agent.passwordHash, PASSWORD)).toBe(true);
    expect(await verifyPassword(agent.passwordHash, 'wrong')).toBe(false);
  });

  it('creates exactly the profile sizes for customers, tickets and messages', async () => {
    expect(await n('SELECT count(*) AS n FROM customers')).toBe(sizes.customers);
    expect(await n('SELECT count(*) AS n FROM tickets')).toBe(sizes.tickets);
    expect(await n('SELECT count(*) AS n FROM messages')).toBe(sizes.messages);
  });

  it('spreads tickets over two years', async () => {
    const r = await iso.db.$queryRawUnsafe<{ days: number }[]>(
      'SELECT extract(epoch FROM (max(created_at) - min(created_at))) / 86400 AS days FROM tickets',
    );
    expect(Number(r[0]?.days)).toBeGreaterThan(600);
  });

  it('has the requested open tickets with running timers and recently resolved ones', async () => {
    expect(
      await n(
        "SELECT count(*) AS n FROM tickets WHERE status IN ('new','open','waiting_customer','on_hold')",
      ),
    ).toBe(sizes.liveActive);
    expect(await n("SELECT count(*) AS n FROM tickets WHERE status = 'resolved'")).toBe(
      sizes.liveResolved,
    );
    expect(
      await n(
        "SELECT count(*) AS n FROM jobs WHERE status = 'pending' AND kind IN ('sla_warning','sla_breach')",
      ),
    ).toBeGreaterThan(sizes.liveActive / 2);
  });

  it('makes some tickets breach within 10 minutes of the seed finishing, relative to startup', async () => {
    const soon = await n(
      `SELECT count(*) AS n FROM jobs WHERE status = 'pending' AND kind = 'sla_breach'
         AND run_at > now() AND run_at <= now() + interval '10 minutes'`,
    );
    expect(soon).toBeGreaterThanOrEqual(sizes.breachSoon);
    // nothing pending is already overdue: past events were recorded as done
    expect(
      await n(
        "SELECT count(*) AS n FROM jobs WHERE status = 'pending' AND kind <> 'auto_close' AND run_at <= now() - interval '1 second'",
      ),
    ).toBe(0);
    expect(seededAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps every agent counter equal to the real load and within the limit', async () => {
    const bad = await n(
      `SELECT count(*) AS n FROM users u
        WHERE u.open_count <> (SELECT count(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('new','open','waiting_customer','on_hold'))
           OR u.open_count > u.ticket_limit`,
    );
    expect(bad).toBe(0);
    expect(await n('SELECT count(*) AS n FROM users WHERE open_count > 0')).toBeGreaterThan(40);
  });

  it('marks every unassigned open ticket as queued', async () => {
    expect(
      await n(
        "SELECT count(*) AS n FROM tickets WHERE assignee_id IS NULL AND status = 'new' AND queued_at IS NULL",
      ),
    ).toBe(0);
  });

  it('has history, ratings and message sequences that line up', async () => {
    expect(await n('SELECT count(*) AS n FROM ticket_events')).toBeGreaterThan(
      sizes.tickets * 2 - 100,
    );
    expect(
      await n('SELECT count(*) AS n FROM surveys WHERE rating BETWEEN 1 AND 5'),
    ).toBeGreaterThan(sizes.tickets * 0.25);
    expect(
      await n(
        'SELECT count(*) AS n FROM tickets t WHERE message_seq <> (SELECT max(seq) FROM messages m WHERE m.ticket_id = t.id)',
      ),
    ).toBe(0);
  });

  it('contains no Cyrillic text anywhere in generated data', async () => {
    const re = '[\\u0400-\\u04FF]';
    expect(await n(`SELECT count(*) AS n FROM customers WHERE name ~ '${re}'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM tickets WHERE subject ~ '${re}'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM messages WHERE body ~ '${re}'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM users WHERE name ~ '${re}'`)).toBe(0);
  });

  it('supports full-text search over the seeded correspondence with the GIN index rebuilt', async () => {
    const idx = await n(
      "SELECT count(*) AS n FROM pg_indexes WHERE indexname IN ('messages_search_gin','tickets_subject_gin','customers_email_trgm','customers_name_trgm')",
    );
    expect(idx).toBe(4);
    expect(
      await n(
        "SELECT count(*) AS n FROM messages WHERE search_vector @@ websearch_to_tsquery('simple', 'invoice')",
      ),
    ).toBeGreaterThan(0);
  });

  it('is idempotent: a second run skips, and reset recreates the same shape', async () => {
    const again = await runSeed(iso.db, {
      profile: 'small',
      randomSeed: 42,
      reset: false,
      passwordHash: 'x',
      clock: systemClock,
      warningRatio: 0.8,
    });
    expect(again).toEqual({ status: 'skipped', reason: 'already-seeded' });
    expect(await n('SELECT count(*) AS n FROM tickets')).toBe(sizes.tickets);
    const none = await runSeed(iso.db, {
      profile: 'none',
      randomSeed: 42,
      reset: false,
      passwordHash: 'x',
      clock: systemClock,
      warningRatio: 0.8,
    });
    expect(none).toEqual({ status: 'skipped', reason: 'profile-none' });
    const reset = await runSeed(iso.db, {
      profile: 'small',
      randomSeed: 42,
      reset: true,
      passwordHash: 'x',
      clock: systemClock,
      warningRatio: 0.8,
    });
    expect(reset.status).toBe('seeded');
    expect(await n('SELECT count(*) AS n FROM tickets')).toBe(sizes.tickets);
    expect(await n('SELECT count(*) AS n FROM messages')).toBe(sizes.messages);
    expect(await n('SELECT min(number) AS n FROM tickets')).toBe(100000);
  });
});
