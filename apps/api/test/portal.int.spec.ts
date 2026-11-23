import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import { multipart } from './attacker/multipart';
import {
  createTeamRow,
  createUserRow,
  login,
  startApi,
  testDb,
  type RunningApi,
} from './helpers/api';
import { createMailbox, linkFor, receiveTicket } from './helpers/tickets';

let api: RunningApi;
const db = testDb();
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

const portal = (token: string) => client({ baseUrl: api.url, auth: { ticketToken: token } });
const setup = async () => {
  const team = await createTeamRow(db);
  const box = await createMailbox(team.id);
  const agent = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] }),
  );
  const t = await receiveTicket(api, box);
  return { team, box, agent, ...t, token: await linkFor(t.ticketId) };
};

describe('customer portal', () => {
  it('shows only customer-visible messages: no notes, no unsent replies, no cancelled ones', async () => {
    const s = await setup();
    await s.agent.client.post(`/api/v1/tickets/${s.ticketId}/take`, {});
    await s.agent.client.post(`/api/v1/tickets/${s.ticketId}/notes`, { body: 'INTERNAL-SECRET' });
    const sent = (
      await s.agent.client.post(`/api/v1/tickets/${s.ticketId}/replies`, {
        body: 'VISIBLE-REPLY',
        lastSeenSeq: 1,
      })
    ).json as { messageId: string };
    const undone = (
      await s.agent.client.post(`/api/v1/tickets/${s.ticketId}/replies`, {
        body: 'UNDONE-REPLY',
        lastSeenSeq: 2,
        confirmNewMessages: true,
      })
    ).json as { messageId: string };
    await s.agent.client.del(`/api/v1/tickets/${s.ticketId}/replies/${undone.messageId}`);
    // before the sender releases it, nothing from the agent is visible
    let view = (await portal(s.token).get('/api/v1/portal/ticket')).json as {
      messages: { body: string }[];
      number: number;
    };
    expect(view.number).toBe(s.number);
    expect(view.messages.map((m) => m.body)).toEqual(['It is stuck']);
    await db.message.update({ where: { id: sent.messageId }, data: { releasedAt: new Date() } });
    view = (await portal(s.token).get('/api/v1/portal/ticket')).json as typeof view;
    expect(view.messages.map((m) => m.body)).toEqual(['It is stuck', 'VISIBLE-REPLY']);
    expect(JSON.stringify(view)).not.toMatch(/INTERNAL-SECRET|UNDONE-REPLY/);
  });

  it('a reply from the portal lands in the same ticket and ends the customer-waiting pause', async () => {
    const s = await setup();
    await s.agent.client.post(`/api/v1/tickets/${s.ticketId}/take`, {});
    await s.agent.client.put(`/api/v1/tickets/${s.ticketId}/status`, {
      status: 'waiting_customer',
    });
    const m = multipart([
      { name: 'body', value: 'Here is more info' },
      { name: 'attachments', filename: 'log.txt', content: Buffer.from('log') },
    ]);
    const r = await portal(s.token).request({
      method: 'POST',
      path: '/api/v1/portal/replies',
      body: m.body,
      headers: m.headers,
    });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ number: s.number, newRequest: false });
    const t = await db.ticket.findUniqueOrThrow({ where: { id: s.ticketId } });
    expect([t.status, t.slaPaused]).toEqual(['open', false]);
    expect(await db.message.count({ where: { ticketId: s.ticketId } })).toBe(2);
  });

  it('a reply on a closed ticket opens a new request linked to the old one', async () => {
    const s = await setup();
    await db.ticket.update({ where: { id: s.ticketId }, data: { status: 'closed' } });
    const m = multipart([{ name: 'body', value: 'It is back' }]);
    const r = await portal(s.token).request({
      method: 'POST',
      path: '/api/v1/portal/replies',
      body: m.body,
      headers: m.headers,
    });
    expect(r.status).toBe(201);
    const j = r.json as { number: number; newRequest: boolean };
    expect(j.newRequest).toBe(true);
    expect((await db.ticket.findFirstOrThrow({ where: { number: j.number } })).followUpOfId).toBe(
      s.ticketId,
    );
  });

  it('validates the reply and downloads attachments only of customer-visible messages', async () => {
    const s = await setup();
    const bad = multipart([{ name: 'body', value: '' }]);
    expect(
      (
        await portal(s.token).request({
          method: 'POST',
          path: '/api/v1/portal/replies',
          body: bad.body,
          headers: bad.headers,
        })
      ).status,
    ).toBe(400);
    const m = multipart([
      { name: 'body', value: 'file' },
      { name: 'attachments', filename: 'a.txt', content: Buffer.from('payload') },
    ]);
    await portal(s.token).request({
      method: 'POST',
      path: '/api/v1/portal/replies',
      body: m.body,
      headers: m.headers,
    });
    const view = (await portal(s.token).get('/api/v1/portal/ticket')).json as {
      messages: { attachments: { id: string }[] }[];
    };
    const id = view.messages.flatMap((x) => x.attachments)[0]?.id ?? '';
    const dl = await portal(s.token).get(`/api/v1/portal/attachments/${id}`);
    expect([dl.status, dl.text]).toEqual([200, 'payload']);
    expect(String(dl.headers['content-disposition'])).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('survey (one per ticket, 7 days, changeable meanwhile)', () => {
  const closed = async () => {
    const s = await setup();
    await s.agent.client.post(`/api/v1/tickets/${s.ticketId}/take`, {});
    const lead = await login(
      api,
      await createUserRow(db, { teams: [{ teamId: s.team.id, role: 'lead' }] }),
    );
    await s.agent.client.put(`/api/v1/tickets/${s.ticketId}/status`, { status: 'resolved' });
    await lead.client.put(`/api/v1/tickets/${s.ticketId}/status`, { status: 'closed' });
    const mail = await db.outboundEmail.findFirstOrThrow({
      where: { ticketId: s.ticketId, purpose: 'survey' },
    });
    const token = /survey#token=([A-Za-z0-9_-]{43})/.exec(mail.bodyText)?.[1] ?? '';
    return { ...s, surveyToken: token };
  };
  const survey = (token: string) =>
    client({ baseUrl: api.url, headers: undefined } as never) && {
      get: () =>
        client({ baseUrl: api.url }).get('/api/v1/survey', {
          headers: { 'x-survey-token': token },
        }),
      put: (b: object) =>
        client({ baseUrl: api.url }).put('/api/v1/survey', b, {
          headers: { 'x-survey-token': token },
        }),
    };

  it('rates, changes the rating and comment within 7 days, and refuses ratings out of range', async () => {
    const s = await closed();
    expect(
      ((await survey(s.surveyToken).get()).json as { rating: number | null }).rating,
    ).toBeNull();
    expect((await survey(s.surveyToken).put({ rating: 4, comment: 'good' })).status).toBe(200);
    const changed = (await survey(s.surveyToken).put({ rating: 2, comment: 'changed my mind' }))
      .json as { rating: number; comment: string };
    expect([changed.rating, changed.comment]).toEqual([2, 'changed my mind']);
    for (const rating of [0, 6, 2.5, '5', null])
      expect((await survey(s.surveyToken).put({ rating })).status).toBe(400);
    expect(await db.survey.count({ where: { ticketId: s.ticketId } })).toBe(1);
  });

  it('refuses unknown or truncated tokens (401) and expired links (410)', async () => {
    const s = await closed();
    for (const t of ['', 'x'.repeat(43), s.surveyToken.slice(0, 40), `${s.surveyToken}x`])
      expect((await survey(t).get()).status).toBe(401);
    await db.survey.update({
      where: { ticketId: s.ticketId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await survey(s.surveyToken).put({ rating: 5 });
    expect([r.status, (r.json as { error: { code: string } }).error.code]).toEqual([
      410,
      'SURVEY_EXPIRED',
    ]);
  });
});
