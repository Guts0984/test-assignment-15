import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertJob, type Db } from '@helpdesk/core';
import {
  dropInbound,
  eventually,
  flushRedis,
  makeTeam,
  startSink,
  startWorker,
  testDb,
  uniq,
  type Sink,
} from './helpers';
import type { WorkerRuntime } from '../src/runtime/runtime';

let db: Db;
let sink: Sink;
let workers: WorkerRuntime[];
let prefix: string;

beforeEach(async () => {
  db = testDb();
  sink = await startSink();
  workers = [];
  prefix = uniq('t');
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  await sink.stop();
  await db.$disconnect();
});

const boot = async (n = 1) => {
  for (let i = 0; i < n; i += 1) workers.push(await startWorker(sink.port, prefix));
};

describe('pipeline: inbound mail -> ticket -> assignment -> acknowledgement', () => {
  it('a stored email becomes a ticket, is assigned to an agent on shift and the customer gets the acknowledgement', async () => {
    const w = await makeTeam(db, { agents: 2 });
    await boot();
    const from = `${uniq('c')}@customer.test`;
    await dropInbound(db, w.mailbox, from, 'My printer is broken');
    const ticket = await eventually(
      async () => {
        const t = await db.ticket.findFirst({ where: { customer: { email: from } } });
        return t?.assigneeId ? t : false;
      },
      20_000,
      'ticket assigned',
    );
    expect(w.agents.map((a) => a.id)).toContain(ticket.assigneeId);
    await eventually(
      async () =>
        (await db.outboundEmail.findFirst({ where: { ticketId: ticket.id, state: 'sent' } })) ??
        false,
      20_000,
      'ack sent',
    );
    const ack = await db.outboundEmail.findFirstOrThrow({ where: { ticketId: ticket.id } });
    expect(sink.delivered.filter((m) => m === `<${ack.rfcMessageId}>`)).toHaveLength(1);
  });
});

describe('INV-8b: several worker copies never run one job twice', () => {
  it('3 workers process 60 inbound mails: 60 tickets, 60 acknowledgements, each mail delivered exactly once', async () => {
    const w = await makeTeam(db, { agents: 6, limit: 50 });
    await boot(3);
    const senders = Array.from({ length: 60 }, () => `${uniq('c')}@customer.test`);
    await Promise.all(senders.map((s) => dropInbound(db, w.mailbox, s, 'Hello')));
    await eventually(
      async () =>
        (await db.outboundEmail.count({
          where: { state: 'sent', ticket: { teamId: w.team.id } },
        })) === 60,
      60_000,
      '60 mails sent',
    );
    expect(await db.ticket.count({ where: { teamId: w.team.id } })).toBe(60);
    expect(
      await db.message.count({ where: { ticket: { teamId: w.team.id }, direction: 'inbound' } }),
    ).toBe(60);
    const sent = await db.outboundEmail.findMany({ where: { ticket: { teamId: w.team.id } } });
    const ids = sent.map((s) => `<${s.rfcMessageId}>`);
    const counts = ids.map((id) => sink.delivered.filter((d) => d === id).length);
    expect(counts.every((n) => n === 1)).toBe(true);
    await eventually(
      async () =>
        (await db.ticket.count({ where: { teamId: w.team.id, assigneeId: { not: null } } })) === 60,
      30_000,
      'all assigned',
    );
    const loads = await Promise.all(
      w.agents.map((a) =>
        db.user.findUniqueOrThrow({ where: { id: a.id } }).then((u) => u.openCount),
      ),
    );
    expect(loads.reduce((a, b) => a + b, 0)).toBe(60);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
  });
});

describe('INV-4b: temporary SMTP errors do not lose or duplicate email', () => {
  it('every third SMTP transaction fails with 451 and still every customer gets exactly one email', async () => {
    const w = await makeTeam(db, { agents: 2 });
    sink.failWhen((n) => (n % 3 === 0 ? 'transient' : null));
    await boot(2);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        dropInbound(db, w.mailbox, `${uniq('c')}@customer.test`, 'Retry me'),
      ),
    );
    await eventually(
      async () =>
        (await db.outboundEmail.count({
          where: { state: 'sent', ticket: { teamId: w.team.id } },
        })) === 12,
      60_000,
      '12 mails sent',
    );
    const rows = await db.outboundEmail.findMany({ where: { ticket: { teamId: w.team.id } } });
    expect(sink.attempts()).toBeGreaterThan(12);
    for (const r of rows)
      expect(sink.delivered.filter((d) => d === `<${r.rfcMessageId}>`)).toHaveLength(1);
  });

  it('a permanently rejected email ends dead and visible, after exhausting nothing else', async () => {
    const w = await makeTeam(db, { agents: 1 });
    sink.failWhen(() => 'permanent');
    await boot();
    await dropInbound(db, w.mailbox, `${uniq('c')}@customer.test`, 'Rejected');
    const dead = await eventually(
      async () =>
        (await db.job.findFirst({
          where: { kind: 'outbound_send', status: 'dead', lastError: { contains: '550' } },
        })) ?? false,
      30_000,
      'dead job',
    );
    expect(dead.lastError).toContain('550');
  });
});

describe('INV-9: losing all of Redis loses nothing', () => {
  it('FLUSHALL with queued tickets, scheduled mail, SLA timers and auto-close pending: everything still completes once', async () => {
    const w = await makeTeam(db, { agents: 2 });
    await boot();
    const mine = await db.ticket.findMany({ where: { teamId: w.team.id } });
    expect(mine).toHaveLength(0);
    // pending work of every kind, all due a little later, so it is waiting in BullMQ when Redis dies
    const soon = (ms: number): Date => new Date(Date.now() + ms);
    const from = `${uniq('c')}@customer.test`;
    const customer = await db.customer.create({ data: { email: from, name: 'C' } });
    const resolved = await db.ticket.create({
      data: {
        teamId: w.team.id,
        customerId: customer.id,
        subject: 'resolved',
        status: 'resolved',
        resolvedAt: new Date(Date.now() - 72 * 3_600_000 + 2000),
      },
    });
    await upsertJob(db, {
      kind: 'auto_close',
      ref: resolved.id,
      dedupeKey: `auto_close:${resolved.id}`,
      runAt: soon(2500),
      now: new Date(),
      payload: { ticketId: resolved.id },
    });
    const timed = await db.ticket.create({
      data: {
        teamId: w.team.id,
        customerId: customer.id,
        subject: 'timer',
        firstResponseWarnAt: soon(2000),
        firstResponseDueAt: soon(3500),
      },
    });
    for (const [event, ms] of [
      ['warning', 2000],
      ['breach', 3500],
    ] as const) {
      await upsertJob(db, {
        kind: event === 'warning' ? 'sla_warning' : 'sla_breach',
        ref: timed.id,
        dedupeKey: `sla:${timed.id}:first_response:${event}`,
        runAt: soon(ms),
        now: new Date(),
        payload: { ticketId: timed.id, target: 'first_response' },
      });
    }
    const scheduled = await db.ticket.create({
      data: { teamId: w.team.id, customerId: customer.id, subject: 'send later' },
    });
    const out = await db.outboundEmail.create({
      data: {
        ticketId: scheduled.id,
        purpose: 'reply',
        toEmail: from,
        subject: 'later',
        bodyText: 'b',
        rfcMessageId: `${uniq('o')}@helpdesk.test`,
        sendAfter: soon(2500),
      },
    });
    await upsertJob(db, {
      kind: 'outbound_send',
      ref: out.id,
      dedupeKey: `outbound:${out.id}`,
      runAt: soon(2500),
      now: new Date(),
      payload: { outboundId: out.id },
    });
    await db.ticket.create({
      data: { teamId: w.team.id, customerId: customer.id, subject: 'queued' },
    });
    await flushRedis();
    await w.agents.length;
    await eventually(
      async () =>
        (await db.ticket.findUniqueOrThrow({ where: { id: resolved.id } })).status === 'closed',
      30_000,
      'auto-closed after flush',
    );
    await eventually(
      async () =>
        (await db.ticket.findUniqueOrThrow({ where: { id: timed.id } })).firstResponseBreached,
      30_000,
      'breach after flush',
    );
    await eventually(
      async () =>
        (await db.outboundEmail.findUniqueOrThrow({ where: { id: out.id } })).state === 'sent',
      30_000,
      'scheduled send after flush',
    );
    await eventually(
      async () =>
        (await db.ticket.count({
          where: { teamId: w.team.id, assigneeId: null, subject: 'queued' },
        })) === 0,
      30_000,
      'queued assignment after flush',
    );
    await eventually(
      async () =>
        (await db.outboundEmail.count({
          where: { ticketId: resolved.id, purpose: 'survey', state: 'sent' },
        })) === 1,
      30_000,
      'survey after flush',
    );
    expect(sink.delivered.filter((d) => d === `<${out.rfcMessageId}>`)).toHaveLength(1);
    expect(await db.ticketEvent.count({ where: { ticketId: timed.id, type: 'sla_warning' } })).toBe(
      1,
    );
    expect(await db.ticketEvent.count({ where: { ticketId: timed.id, type: 'sla_breach' } })).toBe(
      1,
    );
    expect(await db.survey.count({ where: { ticketId: resolved.id } })).toBe(1);
  });
});
