import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import {
  createTeamRow,
  createUserRow,
  login,
  startApi,
  testDb,
  uniq,
  type LoggedIn,
  type RunningApi,
} from './helpers/api';

let api: RunningApi;
let admin: LoggedIn;
const db = testDb();
beforeAll(async () => {
  api = await startApi();
  admin = await login(api, await createUserRow(db, { role: 'admin' }));
});
afterAll(async () => {
  await api.close();
});

const A = '/api/v1/admin';
const teamBody = (over: Record<string, unknown> = {}) => ({
  name: uniq('Team'),
  defaultLanguage: 'en',
  timeZone: 'Europe/Warsaw',
  workdays: [1, 2, 3, 4, 5],
  workStart: '08:00',
  workEnd: '16:30',
  ...over,
});

describe('teams, hours and holidays', () => {
  it('creates a team with hours in its own time zone and lists it', async () => {
    const r = await admin.client.post(`${A}/teams`, teamBody({ name: 'Zeta Team' }));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      name: 'Zeta Team',
      timeZone: 'Europe/Warsaw',
      workStart: '08:00',
      workEnd: '16:30',
      workdays: [1, 2, 3, 4, 5],
    });
    const list = await admin.client.get(`${A}/teams`);
    expect((list.json as { name: string }[]).some((t) => t.name === 'Zeta Team')).toBe(true);
  });

  it('rejects duplicate names with 409 CONFLICT and bad hours with field errors', async () => {
    const name = uniq('Dup');
    expect((await admin.client.post(`${A}/teams`, teamBody({ name }))).status).toBe(201);
    const dup = await admin.client.post(`${A}/teams`, teamBody({ name }));
    expect(dup.status).toBe(409);
    expect((dup.json as { error: { code: string } }).error.code).toBe('CONFLICT');
    expect((await admin.client.post(`${A}/teams`, teamBody({ workEnd: '07:00' }))).status).toBe(
      400,
    );
  });

  it('changes hours and time zone', async () => {
    const t = (await admin.client.post(`${A}/teams`, teamBody())).json as { id: string };
    const r = await admin.client.put(`${A}/teams/${t.id}`, {
      timeZone: 'Europe/Kyiv',
      workdays: [1, 2, 3],
      workStart: '10:00',
      workEnd: '19:00',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      timeZone: 'Europe/Kyiv',
      workStart: '10:00',
      workEnd: '19:00',
      workdays: [1, 2, 3],
    });
    expect(
      (
        await admin.client.put(`${A}/teams/3f2504e0-4f89-41d3-9a0c-0305e82c3301`, {
          timeZone: 'UTC',
          workdays: [1],
          workStart: '09:00',
          workEnd: '10:00',
        })
      ).status,
    ).toBe(404);
  });

  it('adds, lists and removes holidays; duplicates conflict', async () => {
    const t = (await admin.client.post(`${A}/teams`, teamBody())).json as { id: string };
    const h = await admin.client.post(`${A}/teams/${t.id}/holidays`, {
      date: '2026-12-25',
      name: 'Christmas',
    });
    expect(h.status).toBe(201);
    expect(
      (
        await admin.client.post(`${A}/teams/${t.id}/holidays`, {
          date: '2026-12-25',
          name: 'Again',
        })
      ).status,
    ).toBe(409);
    expect(((await admin.client.get(`${A}/teams/${t.id}/holidays`)).json as unknown[]).length).toBe(
      1,
    );
    const id = (h.json as { id: string }).id;
    expect((await admin.client.del(`${A}/teams/${t.id}/holidays/${id}`)).status).toBe(200);
    expect((await admin.client.del(`${A}/teams/${t.id}/holidays/${id}`)).status).toBe(404);
  });
});

describe('agents, limits and languages', () => {
  const agentBody = (teamId: string, over: Record<string, unknown> = {}) => ({
    email: `${uniq('agent')}@test.example`,
    name: 'New Agent',
    password: 'Sup3r-secret!',
    ticketLimit: 12,
    languages: ['en', 'pl'],
    memberships: [{ teamId, role: 'agent' }],
    active: true,
    ...over,
  });

  it('creates an agent who can log in, with limit, languages and team membership', async () => {
    const team = await createTeamRow(db);
    const body = agentBody(team.id);
    const r = await admin.client.post(`${A}/agents`, body);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      ticketLimit: 12,
      languages: ['en', 'pl'],
      memberships: [{ teamId: team.id, role: 'agent' }],
      openCount: 0,
    });
    expect(r.text).not.toContain('passwordHash');
    const anon = client({ baseUrl: api.url });
    expect(
      (await anon.post('/api/v1/auth/login', { email: body.email, password: 'Sup3r-secret!' }))
        .status,
    ).toBe(200);
    expect((await admin.client.post(`${A}/agents`, body)).status).toBe(409);
  });

  it('rejects a membership in a team that does not exist', async () => {
    const r = await admin.client.post(
      `${A}/agents`,
      agentBody('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
    );
    expect(r.status).toBe(404);
  });

  it('lowers a limit below the current load without touching existing tickets', async () => {
    const team = await createTeamRow(db);
    const agent = await createUserRow(db, {
      teams: [{ teamId: team.id, role: 'agent' }],
      limit: 5,
    });
    const cust = await db.customer.create({ data: { email: `${uniq('c')}@x.test`, name: 'C' } });
    for (let i = 0; i < 3; i += 1)
      await db.ticket.create({
        data: {
          teamId: team.id,
          customerId: cust.id,
          subject: 's',
          assigneeId: agent.id,
          status: 'open',
        },
      });
    const r = await admin.client.patch(`${A}/agents/${agent.id}/limits`, {
      ticketLimit: 1,
      languages: ['en', 'de'],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ticketLimit: 1, openCount: 3, languages: ['en', 'de'] });
  });

  it('deactivating an agent returns their tickets to the queue, revokes sessions and blocks login', async () => {
    const team = await createTeamRow(db);
    const agent = await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] });
    const session = await login(api, agent);
    const cust = await db.customer.create({ data: { email: `${uniq('c')}@x.test`, name: 'C' } });
    const t = await db.ticket.create({
      data: {
        teamId: team.id,
        customerId: cust.id,
        subject: 's',
        assigneeId: agent.id,
        status: 'open',
      },
    });
    const view = (await admin.client.get(`${A}/agents`)).json as { id: string; email: string }[];
    const me = view.find((a) => a.id === agent.id);
    expect(me).toBeDefined();
    const r = await admin.client.put(`${A}/agents/${agent.id}`, {
      email: agent.email,
      name: 'Test User',
      ticketLimit: 20,
      languages: ['en'],
      memberships: [{ teamId: team.id, role: 'agent' }],
      active: false,
    });
    expect(r.status).toBe(200);
    const after = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.assigneeId).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: agent.id } })).openCount).toBe(0);
    expect((await session.client.get('/api/v1/auth/me')).status).toBe(401);
    expect(
      (
        await client({ baseUrl: api.url }).post('/api/v1/auth/login', {
          email: agent.email,
          password: 'Test-Passw0rd!',
        })
      ).status,
    ).toBe(401);
    const events = await db.ticketEvent.findMany({
      where: { ticketId: t.id, type: 'returned_to_queue' },
    });
    expect(events).toHaveLength(1);
    expect(
      await db.job.count({ where: { dedupeKey: `assign:${team.id}`, status: 'pending' } }),
    ).toBe(1);
  });

  it("removing an agent from a team returns only that team's tickets", async () => {
    const [t1, t2] = [await createTeamRow(db), await createTeamRow(db)];
    const agent = await createUserRow(db, {
      teams: [
        { teamId: t1.id, role: 'agent' },
        { teamId: t2.id, role: 'agent' },
      ],
    });
    const cust = await db.customer.create({ data: { email: `${uniq('c')}@x.test`, name: 'C' } });
    const a = await db.ticket.create({
      data: {
        teamId: t1.id,
        customerId: cust.id,
        subject: 's',
        assigneeId: agent.id,
        status: 'open',
      },
    });
    const b = await db.ticket.create({
      data: {
        teamId: t2.id,
        customerId: cust.id,
        subject: 's',
        assigneeId: agent.id,
        status: 'open',
      },
    });
    const r = await admin.client.put(`${A}/agents/${agent.id}`, {
      email: agent.email,
      name: 'Test User',
      ticketLimit: 20,
      languages: ['en'],
      memberships: [{ teamId: t2.id, role: 'agent' }],
      active: true,
    });
    expect(r.status).toBe(200);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: a.id } })).assigneeId).toBeNull();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: b.id } })).assigneeId).toBe(agent.id);
  });
});

describe('routing rules, mailboxes and failed jobs', () => {
  it('creates, updates and deletes routing rules (address, subject words, language)', async () => {
    const team = await createTeamRow(db);
    const c = await admin.client.post(`${A}/routing-rules`, {
      position: 5,
      recipient: 'billing@helpdesk.test',
      subjectKeywords: ['invoice'],
      language: 'pl',
      teamId: team.id,
    });
    expect(c.status).toBe(201);
    const id = (c.json as { id: string }).id;
    const u = await admin.client.put(`${A}/routing-rules/${id}`, {
      position: 6,
      enabled: false,
      recipient: null,
      subjectKeywords: ['refund'],
      language: null,
      teamId: team.id,
      priority: 'high',
    });
    expect(u.json).toMatchObject({
      position: 6,
      enabled: false,
      subjectKeywords: ['refund'],
      priority: 'high',
    });
    expect(
      (await admin.client.post(`${A}/routing-rules`, { position: 1, teamId: team.id })).status,
    ).toBe(400);
    expect(
      (
        await admin.client.post(`${A}/routing-rules`, {
          position: 1,
          subjectKeywords: ['x'],
          teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        })
      ).status,
    ).toBe(404);
    expect((await admin.client.del(`${A}/routing-rules/${id}`)).status).toBe(200);
    expect((await admin.client.del(`${A}/routing-rules/${id}`)).status).toBe(404);
  });

  it('manages support mailboxes', async () => {
    const team = await createTeamRow(db);
    const address = `${uniq('box')}@helpdesk.test`;
    expect(
      (
        await admin.client.post(`${A}/mailboxes`, {
          address: address.toUpperCase(),
          defaultTeamId: team.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (await admin.client.post(`${A}/mailboxes`, { address, defaultTeamId: team.id })).status,
    ).toBe(409);
    expect(
      ((await admin.client.get(`${A}/mailboxes`)).json as { address: string }[]).some(
        (m) => m.address === address,
      ),
    ).toBe(true);
  });

  it('shows jobs that exhausted their retries and lets the administrator re-arm them', async () => {
    const key = uniq('dead');
    const job = await db.job.create({
      data: {
        kind: 'outbound_send',
        ref: 'x',
        dedupeKey: key,
        runAt: new Date(),
        status: 'dead',
        attempts: 8,
        lastError: 'SMTP 550 mailbox unavailable',
        createdAt: new Date(),
      },
    });
    const list = (await admin.client.get(`${A}/jobs/failed`)).json as {
      id: string;
      lastError: string;
    }[];
    const mine = list.find((j) => j.id === String(job.id));
    expect(mine?.lastError).toContain('550');
    expect((await admin.client.post(`${A}/jobs/${job.id}/retry`, {})).status).toBe(200);
    expect(await db.job.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect((await admin.client.post(`${A}/jobs/${job.id}/retry`, {})).status).toBe(404);
  });
});

describe('shifts', () => {
  const setup = async () => {
    const team = await createTeamRow(db);
    const agent = await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] });
    const cust = await db.customer.create({ data: { email: `${uniq('c')}@x.test`, name: 'C' } });
    const mk = (replyMinutesAgo: number | null, status = 'open') =>
      db.ticket.create({
        data: {
          teamId: team.id,
          customerId: cust.id,
          subject: 's',
          assigneeId: agent.id,
          status,
          lastPublicReplyAt:
            replyMinutesAgo === null ? null : new Date(Date.now() - replyMinutesAgo * 60_000),
        },
      });
    return { team, agent, mk, session: await login(api, agent) };
  };

  it('going off shift returns tickets without a public reply in the last hour and keeps the rest', async () => {
    const { agent, mk, session, team } = await setup();
    const [stale, never, recent, fresh] = [await mk(61), await mk(null), await mk(59), await mk(1)];
    const r = await session.client.put('/api/v1/me/shift', { onShift: false });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ onShift: false, returnedTickets: 2 });
    const owner = async (id: string) =>
      (await db.ticket.findUniqueOrThrow({ where: { id } })).assigneeId;
    expect([
      await owner(stale.id),
      await owner(never.id),
      await owner(recent.id),
      await owner(fresh.id),
    ]).toEqual([null, null, agent.id, agent.id]);
    expect((await db.user.findUniqueOrThrow({ where: { id: agent.id } })).openCount).toBe(2);
    expect(
      await db.job.count({ where: { dedupeKey: `assign:${team.id}`, status: 'pending' } }),
    ).toBe(1);
    const events = await db.ticketEvent.findMany({
      where: { type: 'returned_to_queue', ticketId: { in: [stale.id, never.id] } },
    });
    expect(events.map((e) => (e.data as { reason: string }).reason)).toEqual([
      'shift_off',
      'shift_off',
    ]);
  });

  it('going on shift makes the agent eligible and requests an assignment run', async () => {
    const { agent, session, team } = await setup();
    await db.user.update({ where: { id: agent.id }, data: { onShift: false } });
    expect((await session.client.put('/api/v1/me/shift', { onShift: true })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: agent.id } })).onShift).toBe(true);
    expect(await db.job.count({ where: { dedupeKey: `assign:${team.id}` } })).toBe(1);
  });

  it('validates the body', async () => {
    const { session } = await setup();
    expect((await session.client.put('/api/v1/me/shift', { onShift: 'yes' })).status).toBe(400);
    expect((await session.client.put('/api/v1/me/shift', {})).status).toBe(400);
  });
});
