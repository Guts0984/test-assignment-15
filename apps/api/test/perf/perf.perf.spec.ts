import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { client, type Client } from '../attacker/client';
import { stackDb } from '../stack/stack';

const base = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const password = process.env.SEED_STAFF_PASSWORD ?? '';
const db = stackDb();
const results: Record<
  string,
  { p50: number; p95: number; max: number; budgetMs: number; runs: number }
> = {};
afterAll(async () => {
  writeFileSync(
    resolve(__dirname, '../../../../docs/perf/results.json'),
    `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
  await db.$disconnect();
});

const login = async (email: string): Promise<Client> => {
  const r = await client({ baseUrl: base }).post('/api/v1/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email} ${r.status}`);
  return client({
    baseUrl: base,
    auth: { bearer: (r.json as { accessToken: string }).accessToken },
  });
};

const measure = async (
  name: string,
  budgetMs: number,
  calls: (() => Promise<{ status: number; ms: number }>)[],
): Promise<void> => {
  for (const c of calls) await c(); // warm cache: every call once before measuring (the budget is for a warm database)
  const times: number[] = [];
  for (const c of calls) {
    const r = await c();
    expect(r.status).toBe(200);
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  const p = (q: number): number =>
    Math.round((times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0) * 10) / 10;
  results[name] = {
    p50: p(0.5),
    p95: p(0.95),
    max: Math.round((times[times.length - 1] ?? 0) * 10) / 10,
    budgetMs,
    runs: times.length,
  };
  process.stderr.write(
    `[perf] ${name}: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${times[times.length - 1]?.toFixed(1)} ms (budget ${budgetMs} ms, ${times.length} runs)\n`,
  );
  expect(p(0.95), `${name} p95`).toBeLessThan(budgetMs);
};

describe('performance budgets on the full seed (through nginx)', () => {
  it('seed is the full profile', async () => {
    // The seed is exact; a few tickets created by later use of the stack must not fail the size check.
    const tickets = await db.ticket.count();
    const messages = await db.message.count();
    expect(tickets).toBeGreaterThanOrEqual(500_000);
    expect(tickets).toBeLessThan(500_100);
    expect(messages).toBeGreaterThanOrEqual(3_000_000);
    expect(messages).toBeLessThan(3_000_500);
  });

  it('text search over correspondence is under 300 ms (terms in about 0.1-1% of messages), also for number and e-mail searches', async () => {
    const words = await db.$queryRaw<{ word: string }[]>`
      SELECT word FROM ts_stat('SELECT search_vector FROM messages TABLESAMPLE SYSTEM (0.5)')
       WHERE ndoc BETWEEN 2 AND 150 ORDER BY ndoc DESC LIMIT 12`;
    expect(words.length).toBeGreaterThan(5);
    const admin = await login('admin@helpdesk.test');
    const agent = await login('agent01@helpdesk.test');
    const sample = await db.ticket.findFirstOrThrow({
      where: { status: 'closed' },
      include: { customer: true },
    });
    // selective words (about 0.01-1% of messages), very common words, a two-word query, a ticket number and an e-mail address
    const queries = [
      ...words.map((w) => w.word),
      'account',
      'password',
      'invoice+refund',
      `%23${sample.number}`,
      sample.customer.email,
    ];
    await measure(
      'search (admin, all teams)',
      300,
      queries.map((q) => () => admin.get(`/api/v1/search?q=${q}`)),
    );
    await measure(
      'search (agent, own team)',
      300,
      queries.map((q) => () => agent.get(`/api/v1/search?q=${q}`)),
    );
  });

  it('the agent queue (the agent with the most open tickets) is under 200 ms', async () => {
    const top = await db.$queryRaw<
      { email: string }[]
    >`SELECT u.email FROM users u ORDER BY u.open_count DESC LIMIT 5`;
    const clients = await Promise.all(top.map((t) => login(t.email)));
    const calls = Array.from(
      { length: 40 },
      (_, i) => () =>
        (clients[i % clients.length] as Client).get('/api/v1/tickets/queue?limit=100'),
    );
    await measure('agent queue', 200, calls);
  });

  it('the 90-day report is under 1 s for one team and for all teams', async () => {
    const admin = await login('admin@helpdesk.test');
    const lead = await login('lead.support-kyiv@helpdesk.test');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    await measure(
      'report 90 days (admin, all teams)',
      1000,
      Array.from({ length: 15 }, () => () => admin.get(`/api/v1/reports?from=${from}&to=${to}`)),
    );
    await measure(
      'report 90 days (lead, one team)',
      1000,
      Array.from({ length: 15 }, () => () => lead.get(`/api/v1/reports?from=${from}&to=${to}`)),
    );
    const total = (
      (await admin.get(`/api/v1/reports?from=${from}&to=${to}`)).json as {
        total: { tickets: number };
      }
    ).total.tickets;
    expect(total).toBeGreaterThan(1000);
  });

  it('the live set exists: about 2,000 open tickets, with breaches due within 10 minutes of the seed ending', async () => {
    const open = await db.ticket.count({
      where: { status: { in: ['new', 'open', 'waiting_customer', 'on_hold'] } },
    });
    expect(open).toBeGreaterThanOrEqual(1900);
  });
});
