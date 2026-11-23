import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { client } from '../attacker/client';
import { connectSocket, rejectedWith } from '../attacker/socket';
import { createTeam, eventually, inject, loginVia, setClock, stackDb, uniq, urls } from './stack';

const db = stackDb();
afterAll(async () => db.$disconnect());
afterEach(async () => setClock({ offsetMs: 0 }));

const anon = () => client({ baseUrl: urls.base });
const arrive = async (team: Awaited<ReturnType<typeof createTeam>>, text: string) => {
  const from = `${uniq('adv')}@customer.test`;
  await inject({ from, to: team.mailbox, subject: 'Adversarial', text });
  const t = await eventually(async () => db.ticket.findFirst({ where: { teamId: team.teamId, customer: { email: from } } }), 60_000, 'ticket');
  return { t, from };
};

describe('route table through nginx (TM-01)', () => {
  it('every protected operation answers 401 without credentials and 403 for an agent on admin routes', async () => {
    const doc = (await anon().get('/docs/openapi.json')).json as { paths: Record<string, Record<string, { 'x-access'?: string; requestBody?: unknown }>> };
    const team = await createTeam({ agents: 1, limit: 5 });
    const agent = team.agents[0];
    let checked = 0;
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const access = op['x-access'];
        expect(access, `${method} ${path}`).toBeDefined();
        if (access === 'public') continue;
        const url = path.replace(/\{[^}]+\}/g, '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
        const r = await anon().request({ method: method.toUpperCase(), path: url, ...(op.requestBody === undefined ? {} : { body: {} }) });
        expect(r.status, `${method} ${path}`).toBe(401);
        if (access === 'admin') expect((await agent?.client.request({ method: method.toUpperCase(), path: url, ...(op.requestBody === undefined ? {} : { body: {} }) }))?.status, `agent ${method} ${path}`).toBe(403);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
    const clock = await anon().post('/api/v1/test/clock', { advanceMs: 1000 });
    expect(clock.status).toBe(403); // reachable in the test profile only with the control token
  });
});

describe('IDOR, internal notes and sockets through nginx (ACC-15)', () => {
  it('another team cannot read, write or subscribe; the customer never receives notes, by REST or socket, on either copy', async () => {
    const [a, b] = [await createTeam({ agents: 1, limit: 5 }), await createTeam({ agents: 1, limit: 5 })];
    const { t, from } = await arrive(a, 'PRIVATE-TEXT');
    const owner = a.agents[0];
    await owner?.client.post(`/api/v1/tickets/${t.id}/take`, {});
    await owner?.client.post(`/api/v1/tickets/${t.id}/notes`, { body: 'INTERNAL-NOTE' });
    const outsider = b.agents[0];
    for (const path of [`/api/v1/tickets/${t.id}`]) expect((await outsider?.client.get(path))?.status).toBe(404);
    for (const [m, path, body] of [['POST', `/api/v1/tickets/${t.id}/notes`, { body: 'x' }], ['PUT', `/api/v1/tickets/${t.id}/status`, { status: 'resolved' }], ['POST', `/api/v1/tickets/${t.id}/take`, {}], ['PUT', `/api/v1/tickets/${t.id}/team`, { teamId: b.teamId }]] as const) {
      expect((await outsider?.client.request({ method: m, path, body }))?.status, `${m} ${path}`).toBe(404);
    }
    expect((await b.lead.client.get(`/api/v1/dashboard/teams/${a.teamId}`)).status).toBe(404);

    const link = await (async () => {
      const { createTicketLink } = await import('../../src/modules/auth/link-tokens');
      return createTicketLink(db, { ticketId: t.id, now: new Date(), ttlDays: 30 });
    })();
    const portal = (await client({ baseUrl: urls.base, auth: { ticketToken: link } }).get('/api/v1/portal/ticket')).text;
    expect(portal).not.toContain('INTERNAL-NOTE');
    for (const base of [urls.api1, urls.api2]) {
      expect(await rejectedWith(base, undefined)).toBe('UNAUTHORIZED');
      expect(await rejectedWith(base, { token: 'x.y.z' })).toBe('UNAUTHORIZED');
      const cust = connectSocket(base, { ticketToken: link });
      const out = connectSocket(base, { token: outsider?.token ?? '' });
      await Promise.all([cust.connected(), out.connected()]);
      expect((await out.emit<{ ok: boolean }>('ticket:subscribe', { ticketId: t.id })).ok).toBe(false);
      await owner?.client.post(`/api/v1/tickets/${t.id}/notes`, { body: `INTERNAL-NOTE-${base}` });
      await new Promise((r) => setTimeout(r, 700));
      expect(JSON.stringify(cust.events)).not.toContain('INTERNAL-NOTE');
      expect(out.events.filter((e) => e.event !== 'time:sync')).toHaveLength(0);
      cust.close();
      out.close();
    }
    void from;
  });

  it('after a merge the old link is revoked, and an expired link answers 410 once the clock moves past its lifetime', async () => {
    const team = await createTeam({ agents: 1, limit: 5 });
    const { t: first, from } = await arrive(team, 'one');
    await inject({ from, to: team.mailbox, subject: 'Adversarial two', text: 'two' });
    const second = await eventually(async () => db.ticket.findFirst({ where: { teamId: team.teamId, customer: { email: from }, subject: 'Adversarial two' } }), 60_000, 'second');
    const { createTicketLink } = await import('../../src/modules/auth/link-tokens');
    const oldLink = await createTicketLink(db, { ticketId: first.id, now: new Date(), ttlDays: 30 });
    const mainLink = await createTicketLink(db, { ticketId: second.id, now: new Date(), ttlDays: 30 });
    expect((await team.agents[0]?.client.post(`/api/v1/tickets/${first.id}/merge`, { targetTicketId: second.id }))?.status).toBe(200);
    const revoked = await client({ baseUrl: urls.base, auth: { ticketToken: oldLink } }).get('/api/v1/portal/ticket');
    expect([revoked.status, (revoked.json as { error: { code: string } }).error.code]).toEqual([410, 'LINK_REVOKED']);
    expect((await client({ baseUrl: urls.base, auth: { ticketToken: mainLink } }).get('/api/v1/portal/ticket')).status).toBe(200);
    await setClock({ advanceMs: 31 * 86_400_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const expired = await client({ baseUrl: urls.base, auth: { ticketToken: mainLink } }).get('/api/v1/portal/ticket');
    expect([expired.status, (expired.json as { error: { code: string } }).error.code]).toEqual([410, 'LINK_EXPIRED']);
  });
});

describe('forged inbound mail and transport abuse through nginx', () => {
  it('rejects unsigned, wrongly signed and replayed webhook calls and creates nothing', async () => {
    const team = await createTeam({ agents: 1, limit: 5 });
    const raw = Buffer.from(`From: evil@x.test\r\nTo: ${team.mailbox}\r\nSubject: forged\r\nMessage-ID: <${uniq('f')}@x.test>\r\n\r\nbody\r\n`);
    const sign = (secret: string, t: number) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const post = (sig?: string) => anon().request({ method: 'POST', path: '/api/v1/inbound/mail', body: raw, headers: { 'content-type': 'message/rfc822', 'x-envelope-to': team.mailbox, ...(sig === undefined ? {} : { 'x-inbound-signature': sig }) } });
    expect((await post()).status).toBe(401);
    expect((await post(sign('wrong-secret-wrong-secret', now))).status).toBe(401);
    expect((await post(sign(process.env.INBOUND_WEBHOOK_SECRET ?? '', now - 3600))).status).toBe(401);
    expect(await db.inboundMessage.count({ where: { mailboxAddress: team.mailbox } })).toBe(0);
  });

  it('slow-header connections do not stop other clients from being served', async () => {
    const host = new URL(urls.base);
    const sockets = Array.from({ length: 60 }, () => {
      const s = connect({ host: host.hostname, port: Number(host.port) });
      s.on('error', () => undefined);
      s.write('GET /api/v1/time HTTP/1.1\r\nHost: x\r\nX-Slow: ');
      return s;
    });
    const times: number[] = [];
    for (let i = 0; i < 30; i += 1) times.push((await anon().get('/api/v1/health')).ms);
    sockets.forEach((s) => s.destroy());
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(500);
  });

  it('an oversized body is refused (413) before it reaches the application, and the stack keeps serving', async () => {
    const r = await anon().request({ method: 'POST', path: '/api/v1/public/tickets', body: Buffer.alloc(16 * 1024 * 1024, 1), headers: { 'content-type': 'multipart/form-data; boundary=x' } });
    expect(r.status).toBe(413);
    expect((await anon().get('/api/v1/health')).status).toBe(200);
  });

  it('security headers and CORS hold behind nginx; no framework or server version leaks', async () => {
    const r = await anon().get('/api/v1/time', { headers: { origin: 'https://evil.example' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(String(r.headers['server'] ?? '')).not.toMatch(/\d/);
  });

  it('staff logins through nginx behave identically for unknown users and wrong passwords', async () => {
    const team = await createTeam({ agents: 1, limit: 5 });
    const [bad, none] = await Promise.all([
      anon().post('/api/v1/auth/login', { email: team.agents[0]?.email, password: 'wrong-password' }),
      anon().post('/api/v1/auth/login', { email: 'nobody@helpdesk.test', password: 'wrong-password' }),
    ]);
    expect([bad.status, none.status]).toEqual([401, 401]);
    expect((bad.json as { error: { code: string } }).error.code).toBe((none.json as { error: { code: string } }).error.code);
    void loginVia;
  });
});
