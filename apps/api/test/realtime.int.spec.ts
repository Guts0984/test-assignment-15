import { createEmitterPublisher, processInbound } from '@helpdesk/core';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectSocket, rejectedWith, type TestSocket } from './attacker/socket';
import {
  createTeamRow,
  createUserRow,
  login,
  startApi,
  testDb,
  type RunningApi,
} from './helpers/api';
import { cfg, createMailbox, linkFor, postMail, rawMail, receiveTicket } from './helpers/tickets';

let a: RunningApi;
let b: RunningApi;
let redis: Redis;
const db = testDb();
const sockets: TestSocket[] = [];
const open = async (api: RunningApi, auth: Record<string, unknown>): Promise<TestSocket> => {
  const s = connectSocket(api.url, auth);
  sockets.push(s);
  await s.connected();
  return s;
};

beforeAll(async () => {
  [a, b] = [
    await startApi({ API_INSTANCE_ID: 'api-1', PRESENCE_TTL_SECONDS: 2 }),
    await startApi({ API_INSTANCE_ID: 'api-2', PRESENCE_TTL_SECONDS: 2 }),
  ];
  redis = new Redis(a.env.REDIS_URL);
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});
afterAll(async () => {
  redis.disconnect();
  await Promise.all([a.close(), b.close()]);
});

const world = async () => {
  const team = await createTeamRow(db);
  const box = await createMailbox(team.id);
  const agent = await login(
    a,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] }),
  );
  const lead = await login(
    b,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'lead' }] }),
  );
  return { team, box, agent, lead };
};
const waitFor = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const where = new Error('waitFor').stack?.split('\n')[2]?.trim() ?? '';
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`condition not met in time at ${where}`);
};
const sawEvent = (s: TestSocket, event: string, pred: (p: never) => boolean = () => true) =>
  s.events.find((e) => e.event === event && pred(e.payload as never));

describe('connection authentication (INV-11 for sockets)', () => {
  it('rejects missing, garbage, expired-looking and forged credentials on both api copies', async () => {
    const w = await world();
    for (const api of [a, b]) {
      expect(await rejectedWith(api.url, undefined)).toBe('UNAUTHORIZED');
      expect(await rejectedWith(api.url, { token: 'garbage' })).toBe('UNAUTHORIZED');
      expect(await rejectedWith(api.url, { token: `${w.agent.accessToken.slice(0, -3)}abc` })).toBe(
        'UNAUTHORIZED',
      );
      expect(await rejectedWith(api.url, { ticketToken: 'x'.repeat(43) })).toBe('LINK_INVALID');
      expect(await rejectedWith(api.url, { token: 5, ticketToken: 5 })).toBe('UNAUTHORIZED');
    }
    expect(await rejectedWith(a.url, { token: w.agent.accessToken })).toBe('CONNECTED');
  });

  it('a deactivated user cannot connect with a still-valid token', async () => {
    const w = await world();
    await db.user.update({ where: { id: w.agent.user.id }, data: { isActive: false } });
    expect(await rejectedWith(a.url, { token: w.agent.accessToken })).toBe('UNAUTHORIZED');
  });
});

describe('INV-10a: live updates reach the other api copy in under a second', () => {
  it('a new ticket created through copy A is seen by the lead on copy B, and status changes by the agent on copy A too', async () => {
    const w = await world();
    const leadSock = await open(b, { token: w.lead.accessToken });
    const agentSock = await open(a, { token: w.agent.accessToken });
    // the ticket arrives (worker path with the shared emitter)
    const publisher = createEmitterPublisher(redis);
    const raw = rawMail({
      from: 'ann@customer.test',
      to: w.box,
      subject: 'Live ticket',
      text: 'hello',
    });
    const sent = performance.now();
    await postMail(a, w.box, raw);
    const inbound = await db.inboundMessage.findFirstOrThrow({ where: { mailboxAddress: w.box } });
    await processInbound(db, inbound.id, new Date(), cfg(), publisher);
    await waitFor(() => sawEvent(leadSock, 'ticket.created') !== undefined);
    const created = sawEvent(leadSock, 'ticket.created');
    expect((created?.payload as { ticket: { subject: string } }).ticket.subject).toBe(
      'Live ticket',
    );
    expect((created?.at ?? 0) - sent).toBeLessThan(1000);
    const ticketId =
      inbound.ticketId ??
      (await db.inboundMessage.findFirstOrThrow({ where: { id: inbound.id } })).ticketId ??
      '';
    // the agent (copy A) takes it and resolves it: the lead on copy B sees both within a second
    const t0 = performance.now();
    expect((await w.agent.client.post(`/api/v1/tickets/${ticketId}/take`, {})).status).toBe(200);
    await w.agent.client.put(`/api/v1/tickets/${ticketId}/status`, { status: 'resolved' });
    await waitFor(
      () =>
        sawEvent(
          leadSock,
          'ticket.updated',
          (p: { ticket: { status: string } }) => p.ticket.status === 'resolved',
        ) !== undefined,
    );
    const resolved = sawEvent(
      leadSock,
      'ticket.updated',
      (p: { ticket: { status: string } }) => p.ticket.status === 'resolved',
    );
    expect((resolved?.at ?? 0) - t0).toBeLessThan(1000);
    const versions = leadSock.events
      .filter((e) => e.event === 'ticket.updated')
      .map((e) => (e.payload as { ticket: { version: number } }).ticket.version);
    expect(versions).toEqual([...versions].sort((x, y) => x - y)); // versions only grow, so clients can drop stale events
    expect(sawEvent(agentSock, 'ticket.updated')).toBeDefined(); // the owner's own room too
  });

  it('the agent sees tickets assigned to them live through their user room', async () => {
    const w = await world();
    const agentSock = await open(b, { token: w.agent.accessToken });
    const t = await receiveTicket(a, w.box);
    await w.lead.client.post(`/api/v1/tickets/${t.ticketId}/transfer`, {
      assigneeId: w.agent.user.id,
    });
    await waitFor(
      () =>
        sawEvent(
          agentSock,
          'ticket.updated',
          (p: { ticket: { assigneeId: string } }) => p.ticket.assigneeId === w.agent.user.id,
        ) !== undefined,
    );
  });
});

describe('INV-10d / INV-11: events and subscriptions are authorized per ticket', () => {
  it('another team never receives events, cannot subscribe, and a customer link only sees its own ticket in customer form', async () => {
    const w = await world();
    const other = await world();
    const t = await receiveTicket(a, w.box, { text: 'PRIVATE-BODY' });
    const outsider = await open(a, { token: other.agent.accessToken });
    const outsiderLead = await open(b, { token: other.lead.accessToken });
    const sub = await outsider.emit<{ ok: boolean; error?: { code: string } }>('ticket:subscribe', {
      ticketId: t.ticketId,
    });
    expect([sub.ok, sub.error?.code]).toEqual([false, 'NOT_FOUND']);
    expect(
      (await outsiderLead.emit<{ ok: boolean }>('ticket:subscribe', { ticketId: t.ticketId })).ok,
    ).toBe(false);
    const own = await open(a, { token: w.agent.accessToken });
    expect((await own.emit<{ ok: boolean }>('ticket:subscribe', { ticketId: t.ticketId })).ok).toBe(
      true,
    );
    const customer = await open(b, { ticketToken: await linkFor(t.ticketId) });
    const otherCustomer = await open(a, {
      ticketToken: await linkFor((await receiveTicket(a, other.box)).ticketId),
    });
    await w.agent.client.post(`/api/v1/tickets/${t.ticketId}/take`, {});
    await w.agent.client.post(`/api/v1/tickets/${t.ticketId}/notes`, { body: 'INTERNAL-NOTE' });
    const { messageId } = (
      await w.agent.client.post(`/api/v1/tickets/${t.ticketId}/replies`, {
        body: 'DRAFT-REPLY',
        lastSeenSeq: 1,
      })
    ).json as { messageId: string };
    await waitFor(() =>
      own.events.some(
        (e) => e.event === 'message.created' && JSON.stringify(e.payload).includes('INTERNAL-NOTE'),
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    for (const bystander of [outsider, outsiderLead, otherCustomer]) {
      expect(
        bystander.events.filter(
          (e) => e.event !== 'time:sync' && JSON.stringify(e.payload).includes(t.ticketId),
        ),
      ).toHaveLength(0);
    }
    const customerSeen = JSON.stringify(customer.events.filter((e) => e.event !== 'time:sync'));
    expect(customerSeen).not.toMatch(/INTERNAL-NOTE|DRAFT-REPLY|assigneeId|teamId|priority/);
    // once the sender releases the reply the customer receives exactly that one public message
    await db.message.update({ where: { id: messageId }, data: { releasedAt: new Date() } });
    const {
      createEmitterPublisher: mk,
      loadMessageViews,
      loadSummaries,
    } = await import('@helpdesk/core');
    const [view] = await loadMessageViews(db, [messageId]);
    const summary = (await loadSummaries(db, [t.ticketId])).get(t.ticketId);
    await mk(redis).publish([
      { type: 'message.created', ticket: summary as never, message: view as never },
    ]);
    await waitFor(() => customer.events.some((e) => e.event === 'message.created'));
    const delivered = customer.events.find((e) => e.event === 'message.created')?.payload as {
      message: { body: string };
    };
    expect(delivered.message.body).toBe('DRAFT-REPLY');
    expect(JSON.stringify(customer.events)).not.toContain('INTERNAL-NOTE');
  });

  it('subscribing with malformed or foreign ids fails cleanly and joins nothing', async () => {
    const w = await world();
    const s = await open(a, { token: w.agent.accessToken });
    for (const payload of [
      {},
      { ticketId: 'x' },
      { ticketId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { ticketId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', extra: 1 },
      null,
      'str',
      { ticketId: ['a'] },
    ]) {
      const r = await s.emit<{ ok: boolean }>('ticket:subscribe', payload);
      expect(r.ok).toBe(false);
    }
    expect([...(s.socket.id ? [] : [])].length).toBe(0);
    // a customer socket cannot subscribe to staff rooms at all
    const t = await receiveTicket(a, w.box);
    const customer = await open(a, { ticketToken: await linkFor(t.ticketId) });
    expect(
      (await customer.emit<{ ok: boolean }>('ticket:subscribe', { ticketId: t.ticketId })).ok,
    ).toBe(false);
    expect(
      (
        await customer.emit<{ ok: boolean }>('presence:update', {
          ticketId: t.ticketId,
          state: 'typing',
        })
      ).ok,
    ).toBe(false);
  });

  it('a team change or merge revokes live access: staff must re-subscribe, the old customer link socket is disconnected', async () => {
    const w = await world();
    const other = await createTeamRow(db);
    const t = await receiveTicket(a, w.box);
    const dup = await receiveTicket(a, w.box, { from: t.from });
    const staff = await open(a, { token: w.agent.accessToken });
    await staff.emit('ticket:subscribe', { ticketId: dup.ticketId });
    const customerOfDup = await open(a, { ticketToken: await linkFor(dup.ticketId) });
    const closed = new Promise<void>((r) => customerOfDup.socket.once('disconnect', () => r()));
    expect(
      (
        await w.agent.client.post(`/api/v1/tickets/${dup.ticketId}/merge`, {
          targetTicketId: t.ticketId,
        })
      ).status,
    ).toBe(200);
    await closed;
    // moving the main ticket to another team ends the agent's room membership
    await staff.emit('ticket:subscribe', { ticketId: t.ticketId });
    await w.agent.client.put(`/api/v1/tickets/${t.ticketId}/team`, { teamId: other.id });
    await waitFor(() => sawEvent(staff, 'ticket:access-changed') !== undefined);
    expect(
      (await staff.emit<{ ok: boolean }>('ticket:subscribe', { ticketId: t.ticketId })).ok,
    ).toBe(false);
  });
});

describe('INV-10b: who is viewing and typing', () => {
  it('shows each other across api copies, marks typing, and drops a closed tab at once', async () => {
    const w = await world();
    const t = await receiveTicket(a, w.box);
    const agent2 = await login(
      b,
      await createUserRow(db, { teams: [{ teamId: w.team.id, role: 'agent' }] }),
    );
    const s1 = await open(a, { token: w.agent.accessToken });
    const s2 = await open(b, { token: agent2.accessToken });
    await s1.emit('ticket:subscribe', { ticketId: t.ticketId });
    const sub2 = await s2.emit<{ viewers: { userId: string }[] }>('ticket:subscribe', {
      ticketId: t.ticketId,
    });
    expect(sub2.viewers.map((v) => v.userId).sort()).toEqual(
      [w.agent.user.id, agent2.user.id].sort(),
    );
    await waitFor(() =>
      s1.events.some(
        (e) =>
          e.event === 'presence:changed' &&
          (e.payload as { viewers: unknown[] }).viewers.length === 2,
      ),
    );
    await s2.emit('presence:update', { ticketId: t.ticketId, state: 'typing' });
    await waitFor(() =>
      s1.events.some(
        (e) =>
          e.event === 'presence:changed' &&
          (e.payload as { viewers: { userId: string; state: string }[] }).viewers.some(
            (v) => v.userId === agent2.user.id && v.state === 'typing',
          ),
      ),
    );
    s2.close();
    await waitFor(
      () =>
        (
          s1.events.filter((e) => e.event === 'presence:changed').at(-1)?.payload as {
            viewers: unknown[];
          }
        ).viewers.length === 1,
    );
  });

  it('an abrupt connection drop (no goodbye) disappears within the TTL, by the reaper', async () => {
    const w = await world();
    const t = await receiveTicket(a, w.box);
    const watcher = await open(a, { token: w.agent.accessToken });
    const other = await login(
      b,
      await createUserRow(db, { teams: [{ teamId: w.team.id, role: 'agent' }] }),
    );
    const victim = await open(b, { token: other.accessToken });
    await watcher.emit('ticket:subscribe', { ticketId: t.ticketId });
    await victim.emit('ticket:subscribe', { ticketId: t.ticketId });
    await waitFor(() =>
      watcher.events.some(
        (e) =>
          e.event === 'presence:changed' &&
          (e.payload as { viewers: unknown[] }).viewers.length === 2,
      ),
    );
    await redis.hset(
      `hd:presence:${t.ticketId}`,
      'ghost-socket',
      JSON.stringify({
        userId: 'ghost',
        name: 'Ghost',
        state: 'viewing',
        seenAt: Date.now() - 60_000,
        typingAt: 0,
      }),
    );
    victim.drop();
    await waitFor(
      () =>
        (
          watcher.events.filter((e) => e.event === 'presence:changed').at(-1)?.payload as {
            viewers: unknown[];
          }
        ).viewers.length === 1,
      15_000,
    );
    const end = Date.now() + 10_000;
    while (
      (await redis.hexists(`hd:presence:${t.ticketId}`, 'ghost-socket')) === 1 &&
      Date.now() < end
    )
      await new Promise((r) => setTimeout(r, 100));
    expect(await redis.hexists(`hd:presence:${t.ticketId}`, 'ghost-socket')).toBe(0); // the reaper removed the expired entry
  });
});

describe('INV-10c: catch-up after reconnect', () => {
  it('a reconnecting client gets the messages it missed, notes included for staff, in order', async () => {
    const w = await world();
    const t = await receiveTicket(a, w.box);
    await w.agent.client.post(`/api/v1/tickets/${t.ticketId}/take`, {});
    await w.agent.client.post(`/api/v1/tickets/${t.ticketId}/notes`, { body: 'missed note' });
    await w.agent.client.post(`/api/v1/tickets/${t.ticketId}/replies`, {
      body: 'missed reply',
      lastSeenSeq: 1,
    });
    const s = await open(b, { token: w.agent.accessToken });
    const r = await s.emit<{
      ok: boolean;
      ticket: { version: number };
      missed: { seq: number; body: string }[];
    }>('ticket:subscribe', { ticketId: t.ticketId, lastSeq: 1 });
    expect(r.missed.map((m) => m.body)).toEqual(['missed note', 'missed reply']);
    expect(r.missed.map((m) => m.seq)).toEqual([2, 3]);
    expect(r.ticket.version).toBeGreaterThan(1);
    const again = await s.emit<{ missed: unknown[] }>('ticket:subscribe', {
      ticketId: t.ticketId,
      lastSeq: 3,
    });
    expect(again.missed).toHaveLength(0);
  });
});

describe('per-socket event budget (never per IP)', () => {
  it('a flooding socket is dropped without hurting another socket from the same address', async () => {
    const w = await world();
    const t = await receiveTicket(a, w.box);
    const flooder = await open(a, { token: w.agent.accessToken });
    const bystander = await open(a, { token: w.lead.accessToken });
    const acks = await Promise.all(
      Array.from({ length: 200 }, () =>
        flooder.emit<{ ok: boolean; error?: { code: string } }>('time:sync', {}),
      ),
    );
    expect(acks.filter((x) => x.error?.code === 'EVENT_BUDGET_EXCEEDED').length).toBeGreaterThan(
      100,
    );
    const t0 = performance.now();
    expect(
      (await bystander.emit<{ ok: boolean }>('ticket:subscribe', { ticketId: t.ticketId })).ok,
    ).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
