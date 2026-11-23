import { afterAll, describe, expect, it } from 'vitest';
import { client } from '../attacker/client';
import { createTeam, customersOf, eventually, inject, stackDb, urls, uniq } from './stack';

const db = stackDb();
afterAll(async () => db.$disconnect());

describe('topology', () => {
  it('serves through nginx from both api copies and exposes the OpenAPI docs', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) seen.add(String((await client({ baseUrl: urls.base }).get('/api/v1/health')).headers['x-api-instance']));
    expect([...seen].sort()).toEqual(['api-1', 'api-2']);
    expect((await client({ baseUrl: urls.base }).get('/docs')).status).toBe(200);
    expect((await fetch(urls.base + '/login')).status).toBe(200);
  });
});

describe('ACC-6 / INV-1: 500 simultaneous inbound mails, 10 agents (limit 20), 3 workers', () => {
  it('every agent ends with exactly 20, 300 wait in the queue, and a freed slot is refilled at once', async () => {
    const team = await createTeam({ agents: 10, limit: 20 });
    const prefix = uniq('c500');
    const senders = customersOf(prefix, 500);
    const started = Date.now();
    await Promise.all(senders.map((from) => inject({ from, to: team.mailbox, subject: 'Burst', text: 'help' })));
    await eventually(async () => (await db.ticket.count({ where: { teamId: team.teamId } })) === 500, 120_000, '500 tickets created');
    await eventually(async () => (await db.ticket.count({ where: { teamId: team.teamId, assigneeId: { not: null } } })) === 200, 120_000, '200 assigned');
    process.stderr.write(`[acc6] 500 mails processed in ${Math.round((Date.now() - started) / 1000)} s\n`);
    for (const a of team.agents) {
      const u = await db.user.findUniqueOrThrow({ where: { id: a.id } });
      expect([u.openCount, await db.ticket.count({ where: { assigneeId: a.id, status: { in: ['new', 'open', 'waiting_customer', 'on_hold'] } } })]).toEqual([20, 20]);
    }
    expect(await db.ticket.count({ where: { teamId: team.teamId, assigneeId: null } })).toBe(300);
    expect(await db.ticket.count({ where: { teamId: team.teamId, customer: { email: { startsWith: prefix } } } })).toBe(500); // no duplicates

    const first = team.agents[0];
    const own = await db.ticket.findFirstOrThrow({ where: { assigneeId: first?.id } });
    const closedAt = Date.now();
    expect((await first?.client.put(`/api/v1/tickets/${own.id}/status`, { status: 'resolved' }))?.status).toBe(200);
    await eventually(async () => (await db.ticket.count({ where: { teamId: team.teamId, assigneeId: { not: null }, status: { in: ['new', 'open'] } } })) === 200, 20_000, 'slot refilled');
    process.stderr.write(`[acc6] next ticket assigned ${Date.now() - closedAt} ms after resolving\n`);
    expect((await db.user.findUniqueOrThrow({ where: { id: first?.id } })).openCount).toBe(20);
    expect(await db.ticket.count({ where: { teamId: team.teamId, assigneeId: null } })).toBe(299);
  });
});
