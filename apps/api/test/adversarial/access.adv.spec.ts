import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from '../attacker/client';
import { multipart } from '../attacker/multipart';
import {
  createTeamRow,
  createUserRow,
  login,
  startApi,
  testDb,
  type LoggedIn,
  type RunningApi,
} from '../helpers/api';
import { createMailbox, linkFor, receiveTicket } from '../helpers/tickets';

type World = {
  a: {
    team: { id: string };
    agent: LoggedIn;
    lead: LoggedIn;
    ticket: { ticketId: string; number: number; from: string };
  };
  b: {
    team: { id: string };
    agent: LoggedIn;
    lead: LoggedIn;
    ticket: { ticketId: string; number: number; from: string };
  };
  admin: LoggedIn;
};
let api: RunningApi;
let w: World;
const db = testDb();

const team = async () => {
  const t = await createTeamRow(db);
  const box = await createMailbox(t.id);
  const agent = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: t.id, role: 'agent' }] }),
  );
  const lead = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: t.id, role: 'lead' }] }),
  );
  const ticket = await receiveTicket(api, box, { text: 'TEAM-PRIVATE-TEXT' });
  await agent.client.post(`/api/v1/tickets/${ticket.ticketId}/take`, {});
  await agent.client.post(`/api/v1/tickets/${ticket.ticketId}/notes`, { body: 'NOTE-PRIVATE' });
  return { team: t, agent, lead, ticket };
};

beforeAll(async () => {
  api = await startApi();
  w = {
    a: await team(),
    b: await team(),
    admin: await login(api, await createUserRow(db, { role: 'admin' })),
  };
});
afterAll(async () => {
  await api.close();
});

describe('IDOR: staff cannot touch tickets of other teams (404, nothing changes)', () => {
  const T = '/api/v1/tickets';
  it('every ticket route answers 404 for an agent or lead of another team', async () => {
    const id = w.a.ticket.ticketId;
    const before = await db.ticket.findUniqueOrThrow({ where: { id } });
    for (const who of [w.b.agent, w.b.lead]) {
      const calls = [
        who.client.get(`${T}/${id}`),
        who.client.post(`${T}/${id}/replies`, {
          body: 'x',
          lastSeenSeq: 0,
          confirmedSeq: 5,
        }),
        who.client.post(`${T}/${id}/notes`, { body: 'x' }),
        who.client.put(`${T}/${id}/status`, { status: 'resolved' }),
        who.client.put(`${T}/${id}/priority`, { priority: 'urgent' }),
        who.client.put(`${T}/${id}/team`, { teamId: w.b.team.id }),
        who.client.post(`${T}/${id}/transfer`, { assigneeId: who.user.id }),
        who.client.post(`${T}/${id}/take`, {}),
        who.client.post(`${T}/${id}/merge`, { targetTicketId: w.b.ticket.ticketId }),
        who.client.post(`${T}/${w.b.ticket.ticketId}/merge`, { targetTicketId: id }),
        who.client.del(`${T}/${id}/replies/3f2504e0-4f89-41d3-9a0c-0305e82c3301`),
        who.client.get(`/api/v1/dashboard/teams/${w.a.team.id}`),
      ];
      for (const r of await Promise.all(calls)) {
        expect(r.status).toBe(404);
        expect(r.text).not.toContain('TEAM-PRIVATE-TEXT');
      }
    }
    const after = await db.ticket.findUniqueOrThrow({ where: { id } });
    expect([after.version, after.teamId, after.status, after.assigneeId, after.priority]).toEqual([
      before.version,
      before.teamId,
      before.status,
      before.assigneeId,
      before.priority,
    ]);
    expect(await db.message.count({ where: { ticketId: id } })).toBe(2);
  });

  it('a foreign ticket looks exactly like a missing one (no existence oracle)', async () => {
    const foreign = await w.b.agent.client.get(`${T}/${w.a.ticket.ticketId}`);
    const missing = await w.b.agent.client.get(`${T}/3f2504e0-4f89-41d3-9a0c-0305e82c3301`);
    const strip = (j: unknown) => JSON.stringify(j, (k, v) => (k === 'requestId' ? undefined : v));
    expect([foreign.status, strip(foreign.json)]).toEqual([missing.status, strip(missing.json)]);
  });

  it('search, queues and reports never include other teams', async () => {
    const found = (await w.b.agent.client.get('/api/v1/search?q=TEAM-PRIVATE-TEXT')).json as {
      items: { id: string; teamId: string }[];
    };
    expect(found.items.map((i) => i.id)).toEqual([w.b.ticket.ticketId]); // both teams hold the phrase; only the own one is visible
    expect(found.items.every((i) => i.teamId === w.b.team.id)).toBe(true);
    const un = (await w.b.agent.client.get(`${T}/unassigned`)).json as { items: { id: string }[] };
    expect(un.items.map((i) => i.id)).not.toContain(w.a.ticket.ticketId);
    expect((await w.b.agent.client.get(`${T}/unassigned?teamId=${w.a.team.id}`)).status).toBe(404);
    expect(
      (
        await w.b.lead.client.get(
          `/api/v1/reports?from=2026-01-01&to=2026-12-31&teamId=${w.a.team.id}`,
        )
      ).status,
    ).toBe(404);
    const own = (await w.b.lead.client.get('/api/v1/reports?from=2026-01-01&to=2026-12-31'))
      .json as { byTeam: { teamId: string }[] };
    expect(own.byTeam.every((t) => t.teamId === w.b.team.id)).toBe(true);
  });

  it('attachments of another team are not downloadable', async () => {
    const m = await db.message.findFirstOrThrow({ where: { ticketId: w.a.ticket.ticketId } });
    const att = await db.attachment.create({
      data: {
        messageId: m.id,
        filename: 'x.txt',
        contentType: 'text/plain',
        size: 1,
        data: Buffer.from('x'),
      },
    });
    expect((await w.b.agent.client.get(`/api/v1/attachments/${att.id}`)).status).toBe(404);
    expect((await w.a.agent.client.get(`/api/v1/attachments/${att.id}`)).status).toBe(200);
  });

  it('admin sees everything; a lead cannot read notes of another team through merge or transfer tricks', async () => {
    expect((await w.admin.client.get(`/api/v1/tickets/${w.a.ticket.ticketId}`)).status).toBe(200);
    expect((await w.admin.client.get(`/api/v1/tickets/${w.b.ticket.ticketId}`)).status).toBe(200);
    expect(
      (
        await w.b.lead.client.post(`/api/v1/tickets/${w.b.ticket.ticketId}/transfer`, {
          assigneeId: w.a.agent.user.id,
        })
      ).status,
    ).toBe(404);
  });

  it('mass assignment: extra fields in commands are rejected, not applied', async () => {
    const r = await w.a.agent.client.put(`/api/v1/tickets/${w.a.ticket.ticketId}/status`, {
      status: 'open',
      assigneeId: w.b.agent.user.id,
      teamId: w.b.team.id,
    });
    expect(r.status).toBe(400);
    const n = await w.a.agent.client.post(`/api/v1/tickets/${w.a.ticket.ticketId}/notes`, {
      body: 'x',
      kind: 'public',
      isInternal: false,
    });
    expect(n.status).toBe(400);
  });
});

describe('internal notes never reach customers (REST, portal, email, search)', () => {
  it('has no path from a customer link to a note', async () => {
    const token = await linkFor(w.a.ticket.ticketId);
    const c = client({ baseUrl: api.url, auth: { ticketToken: token } });
    const view = await c.get('/api/v1/portal/ticket');
    expect(view.text).not.toContain('NOTE-PRIVATE');
    const noteMsg = await db.message.findFirstOrThrow({
      where: { ticketId: w.a.ticket.ticketId, kind: 'note' },
    });
    const att = await db.attachment.create({
      data: {
        messageId: noteMsg.id,
        filename: 'secret.txt',
        contentType: 'text/plain',
        size: 1,
        data: Buffer.from('s'),
      },
    });
    expect((await c.get(`/api/v1/portal/attachments/${att.id}`)).status).toBe(404);
    expect((await c.get(`/api/v1/tickets/${w.a.ticket.ticketId}`)).status).toBe(401);
    expect((await c.get('/api/v1/search?q=NOTE-PRIVATE')).status).toBe(401);
    // no email ever carries the note
    const mails = await db.outboundEmail.findMany({ where: { ticketId: w.a.ticket.ticketId } });
    expect(mails.some((m) => m.bodyText.includes('NOTE-PRIVATE'))).toBe(false);
  });
});

describe('magic links: one ticket, expire, revoked on merge', () => {
  it('a link for ticket A cannot read or write ticket B and cannot use staff routes', async () => {
    const tokenA = await linkFor(w.a.ticket.ticketId);
    const c = client({ baseUrl: api.url, auth: { ticketToken: tokenA } });
    const view = (await c.get('/api/v1/portal/ticket')).json as { number: number };
    expect(view.number).toBe(w.a.ticket.number);
    expect(view.number).not.toBe(w.b.ticket.number);
    const m = multipart([{ name: 'body', value: 'mine' }]);
    await c.request({
      method: 'POST',
      path: '/api/v1/portal/replies',
      body: m.body,
      headers: m.headers,
    });
    expect(await db.message.count({ where: { ticketId: w.b.ticket.ticketId } })).toBe(2);
    for (const path of ['/api/v1/tickets/queue', '/api/v1/auth/me', '/api/v1/admin/teams'])
      expect((await c.get(path)).status).toBe(401);
  });

  it('guessed, truncated, altered and query-string tokens fail; the token is not accepted as a bearer', async () => {
    const t = await linkFor(w.a.ticket.ticketId);
    for (const bad of [
      t.slice(0, 42),
      `${t}A`,
      t.toUpperCase(),
      'A'.repeat(43),
      t.replace(/.$/, t.endsWith('A') ? 'B' : 'A'),
    ]) {
      expect(
        (
          await client({ baseUrl: api.url, auth: { ticketToken: bad } }).get(
            '/api/v1/portal/ticket',
          )
        ).status,
        bad,
      ).toBe(401);
    }
    expect(
      (await client({ baseUrl: api.url }).get(`/api/v1/portal/ticket?token=${t}`)).status,
    ).toBe(401);
    expect(
      (await client({ baseUrl: api.url, auth: { bearer: t } }).get('/api/v1/portal/ticket')).status,
    ).toBe(401);
  });

  it('expired links answer 410 LINK_EXPIRED and revoked links 410 LINK_REVOKED', async () => {
    const t = await linkFor(w.a.ticket.ticketId);
    await db.ticketAccessToken.updateMany({
      where: { ticketId: w.a.ticket.ticketId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await client({ baseUrl: api.url, auth: { ticketToken: t } }).get(
      '/api/v1/portal/ticket',
    );
    expect([expired.status, (expired.json as { error: { code: string } }).error.code]).toEqual([
      410,
      'LINK_EXPIRED',
    ]);
    const t2 = await linkFor(w.a.ticket.ticketId);
    await db.ticketAccessToken.updateMany({
      where: { ticketId: w.a.ticket.ticketId, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    const revoked = await client({ baseUrl: api.url, auth: { ticketToken: t2 } }).get(
      '/api/v1/portal/ticket',
    );
    expect([revoked.status, (revoked.json as { error: { code: string } }).error.code]).toEqual([
      410,
      'LINK_REVOKED',
    ]);
  });

  it('after a merge the duplicate link stops working while the main ticket link keeps working', async () => {
    const t = await team();
    const dup = await receiveTicket(
      api,
      (await db.mailbox.findFirstOrThrow({ where: { defaultTeamId: t.team.id } })).address,
      { from: t.ticket.from },
    );
    const dupLink = await linkFor(dup.ticketId);
    const mainLink = await linkFor(t.ticket.ticketId);
    expect(
      (
        await client({ baseUrl: api.url, auth: { ticketToken: dupLink } }).get(
          '/api/v1/portal/ticket',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await t.agent.client.post(`/api/v1/tickets/${dup.ticketId}/merge`, {
          targetTicketId: t.ticket.ticketId,
        })
      ).status,
    ).toBe(200);
    const r = await client({ baseUrl: api.url, auth: { ticketToken: dupLink } }).get(
      '/api/v1/portal/ticket',
    );
    expect([r.status, (r.json as { error: { code: string } }).error.code]).toEqual([
      410,
      'LINK_REVOKED',
    ]);
    expect(
      (
        await client({ baseUrl: api.url, auth: { ticketToken: mainLink } }).get(
          '/api/v1/portal/ticket',
        )
      ).status,
    ).toBe(200);
  });

  it('the web form never hands out a link, so submitting with a victim email gives the attacker nothing', async () => {
    const m = multipart([
      { name: 'email', value: w.a.ticket.from },
      { name: 'name', value: 'Attacker' },
      { name: 'subject', value: 'hi' },
      { name: 'body', value: 'hi' },
    ]);
    const r = await client({ baseUrl: api.url }).request({
      method: 'POST',
      path: '/api/v1/public/tickets',
      body: m.body,
      headers: m.headers,
    });
    expect(r.status).toBe(201);
    expect(r.text).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(JSON.stringify(r.headers)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
