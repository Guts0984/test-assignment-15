import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { connectSocket } from '../attacker/socket';
import {
  createTeam,
  customersOf,
  dc,
  eventually,
  flushRedis,
  inject,
  loginVia,
  setClock,
  stackDb,
  stubMail,
  uniq,
  urls,
  workerContainers,
} from './stack';

const sh = promisify(execFile);
const db = stackDb();
afterAll(async () => db.$disconnect());
afterEach(async () => {
  await setClock({ offsetMs: 0 });
  await dc('up', '-d', '--wait', 'worker').catch(() => undefined);
});
const H = 3_600_000;

describe('ACC-12 / INV-8a: kill -9 of a worker during a flow of inbound mail', () => {
  it('processes every mail after the restart: no lost mail, no duplicate tickets or messages', async () => {
    const team = await createTeam({ agents: 5, limit: 100 });
    const senders = customersOf(uniq('kill'), 300);
    const feeding = Promise.all(
      senders.map((from, i) => inject({ from, to: team.mailbox, subject: `Flow ${i}`, text: 'x' })),
    );
    await eventually(
      async () => (await db.ticket.count({ where: { teamId: team.teamId } })) >= 40,
      60_000,
      'processing started',
    );
    const victims = await workerContainers();
    await sh('docker', ['kill', '-s', 'KILL', ...victims.slice(0, 2)]); // two of three workers die mid-flight
    await feeding;
    await dc('up', '-d', '--wait', 'worker');
    await eventually(
      async () => (await db.ticket.count({ where: { teamId: team.teamId } })) === 300,
      180_000,
      '300 tickets',
    );
    await eventually(
      async () =>
        (await db.inboundMessage.count({
          where: { mailboxAddress: team.mailbox, state: 'pending' },
        })) === 0,
      120_000,
      'no pending inbound mail',
    );
    expect(await db.inboundMessage.count({ where: { mailboxAddress: team.mailbox } })).toBe(300);
    expect(await db.ticket.count({ where: { teamId: team.teamId } })).toBe(300);
    expect(
      await db.message.count({
        where: { ticket: { teamId: team.teamId }, direction: 'inbound', autoKind: null },
      }),
    ).toBe(300);
    for (const s of senders.slice(0, 20))
      expect(await db.ticket.count({ where: { customer: { email: s } } })).toBe(1);
    await eventually(
      async () =>
        (await db.outboundEmail.count({
          where: { ticket: { teamId: team.teamId }, state: 'sent' },
        })) === 300,
      180_000,
      'acknowledgements sent',
    );
    const received = await stubMail({ limit: 20000 });
    const sent = await db.outboundEmail.findMany({ where: { ticket: { teamId: team.teamId } } });
    // Every acknowledgement is in the customer's mailbox exactly once. A kill -9 between the SMTP "250" and our `sent`
    // commit makes the sender repeat the send after the lease expires (same Message-ID); the receiving side, like a
    // real mailbox provider, acknowledges the repeat without storing it again (MAIL_STUB_DEDUPE_MESSAGE_ID).
    const copies = sent.map(
      (row) => received.filter((m) => m.messageId === `<${row.rfcMessageId}>`).length,
    );
    expect(copies.every((n) => n === 1)).toBe(true);
  });
});

describe('ACC-12 / INV-9: FLUSHALL while SLA timers, scheduled mail and a queue are live', () => {
  it('warnings and breaches fire once each, the scheduled reply is sent once, queued tickets are assigned', async () => {
    const team = await createTeam({ agents: 1, limit: 1 });
    const agent = team.agents[0];
    const mk = async (subject: string, priority: string) => {
      const from = `${uniq('flush')}@customer.test`;
      await inject({ from, to: team.mailbox, subject, text: 'x' });
      const t = await eventually(
        async () =>
          db.ticket.findFirst({ where: { teamId: team.teamId, customer: { email: from } } }),
        60_000,
        'ticket',
      );
      await agent?.client
        .put(`/api/v1/tickets/${t.id}/priority`, { priority })
        .catch(() => undefined);
      return { t, from };
    };
    const timed = await mk('Timers', 'urgent');
    await eventually(
      async () =>
        (await db.ticket.findUniqueOrThrow({ where: { id: timed.t.id } })).assigneeId === agent?.id,
      30_000,
      'assigned',
    );
    const queued = await mk('Waiting in queue', 'normal'); // the single slot is taken, so this one waits
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: queued.t.id } })).assigneeId,
    ).toBeNull();
    const reply = (
      await agent?.client.post(`/api/v1/tickets/${timed.t.id}/replies`, {
        body: 'FLUSH-REPLY',
        lastSeenSeq: 1,
      })
    )?.json as { messageId: string };
    await flushRedis();
    await setClock({ advanceMs: 61 * 60_000 }); // past the 1 h urgent first-response deadline and the 10 s send delay
    await eventually(
      async () =>
        (await db.outboundEmail.count({ where: { messageId: reply.messageId, state: 'sent' } })) ===
        1,
      60_000,
      'scheduled send after flush',
    );
    // the reply answered the first response in time, so only the resolution warning (80% of 4 h = 3.2 h) is still ahead
    await setClock({ advanceMs: 3 * H });
    await eventually(
      async () =>
        (await db.ticketEvent.count({ where: { ticketId: timed.t.id, type: 'sla_warning' } })) ===
        1,
      60_000,
      'warning after flush',
    );
    await setClock({ advanceMs: 2 * H });
    await eventually(
      async () =>
        (await db.ticketEvent.count({ where: { ticketId: timed.t.id, type: 'sla_breach' } })) === 1,
      60_000,
      'breach after flush',
    );
    await flushRedis();
    await new Promise((r) => setTimeout(r, 6000));
    for (const type of ['sla_warning', 'sla_breach'])
      expect(await db.ticketEvent.count({ where: { ticketId: timed.t.id, type } })).toBe(1);
    expect(
      (await stubMail({ to: timed.from })).filter((m) => m.text.includes('FLUSH-REPLY')),
    ).toHaveLength(1);
    // free the slot: the queued ticket is assigned although Redis was wiped twice (tokens expired during the clock jumps)
    const fresh = await loginVia(urls.base, agent?.email ?? '', 'Stack-Passw0rd!');
    await fresh.client.put(`/api/v1/tickets/${timed.t.id}/status`, { status: 'resolved' });
    await eventually(
      async () =>
        (await db.ticket.findUniqueOrThrow({ where: { id: queued.t.id } })).assigneeId ===
        agent?.id,
      60_000,
      'queued ticket assigned after flush',
    );
  });
});

describe('ACC-13 / INV-3c: workers down for two hours, then up', () => {
  it('catches up warnings, breaches and auto-close, each exactly once and in order', async () => {
    const team = await createTeam({ agents: 1, limit: 10 });
    const agent = team.agents[0];
    const urgentFrom = `${uniq('down')}@customer.test`;
    await inject({ from: urgentFrom, to: team.mailbox, subject: 'Down timers', text: 'x' });
    const t = await eventually(
      async () =>
        db.ticket.findFirst({ where: { teamId: team.teamId, customer: { email: urgentFrom } } }),
      60_000,
      'ticket',
    );
    await agent?.client.put(`/api/v1/tickets/${t.id}/priority`, { priority: 'urgent' });
    const resolvedFrom = `${uniq('down')}@customer.test`;
    await inject({ from: resolvedFrom, to: team.mailbox, subject: 'Down resolved', text: 'x' });
    const r = await eventually(
      async () =>
        db.ticket.findFirst({ where: { teamId: team.teamId, customer: { email: resolvedFrom } } }),
      60_000,
      'ticket',
    );
    await eventually(
      async () =>
        (await db.ticket.findUniqueOrThrow({ where: { id: r.id } })).assigneeId === agent?.id,
      30_000,
      'assigned',
    );
    await agent?.client.put(`/api/v1/tickets/${r.id}/status`, { status: 'resolved' });
    // pretend it was resolved 71 h ago so auto-close (72 h) falls inside the two hours of downtime
    await db.$executeRaw`UPDATE tickets SET resolved_at = resolved_at - interval '71 hours' WHERE id = ${r.id}::uuid`;
    await db.$executeRaw`UPDATE jobs SET run_at = run_at - interval '71 hours' + interval '30 minutes' WHERE dedupe_key = ${`auto_close:${r.id}`}`;
    await db.$executeRaw`UPDATE jobs SET run_at = now() + interval '30 minutes' WHERE dedupe_key = ${`auto_close:${r.id}`}`;
    await dc('stop', 'worker');
    await setClock({ advanceMs: 2 * H + 5 * 60_000 });
    await new Promise((x) => setTimeout(x, 3000));
    expect(
      await db.ticketEvent.count({
        where: { ticketId: t.id, type: { in: ['sla_warning', 'sla_breach'] } },
      }),
    ).toBe(0); // nobody was running
    expect((await db.ticket.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('resolved');
    await dc('start', 'worker');
    await eventually(
      async () => (await db.ticket.findUniqueOrThrow({ where: { id: r.id } })).status === 'closed',
      120_000,
      'auto-close caught up',
    );
    await eventually(
      async () =>
        (await db.ticketEvent.count({ where: { ticketId: t.id, type: 'sla_breach' } })) >= 1,
      120_000,
      'breach caught up',
    );
    await new Promise((x) => setTimeout(x, 5000));
    const events = (
      await db.ticketEvent.findMany({
        where: { ticketId: t.id, type: { in: ['sla_warning', 'sla_breach'] } },
        orderBy: { id: 'asc' },
      })
    ).map((e) => `${e.type}:${(e.data as { target: string }).target}`);
    expect(events.filter((e) => e === 'sla_warning:first_response')).toHaveLength(1);
    expect(events.filter((e) => e === 'sla_breach:first_response')).toHaveLength(1);
    expect(events.indexOf('sla_warning:first_response')).toBeLessThan(
      events.indexOf('sla_breach:first_response'),
    );
    expect(await db.survey.count({ where: { ticketId: r.id } })).toBe(1);
    expect(await db.outboundEmail.count({ where: { ticketId: r.id, purpose: 'survey' } })).toBe(1);
  });
});

describe('ACC-14 / INV-10: live updates between the two api copies', () => {
  it('a lead on copy B sees the new ticket and the status change made through copy A in under a second', async () => {
    const team = await createTeam({ agents: 1, limit: 10 });
    const agentA = await loginVia(urls.api1, team.agents[0]?.email ?? '', 'Stack-Passw0rd!');
    const leadB = await loginVia(urls.api2, team.lead.email, 'Stack-Passw0rd!');
    const leadSock = connectSocket(urls.api2, { token: leadB.token });
    const agentSock = connectSocket(urls.api1, { token: agentA.token });
    await Promise.all([leadSock.connected(), agentSock.connected()]);
    const from = `${uniq('live')}@customer.test`;
    const t0 = performance.now();
    await inject({ from, to: team.mailbox, subject: 'Live check', text: 'x' });
    await eventually(
      async () => leadSock.events.find((e) => e.event === 'ticket.created'),
      20_000,
      'ticket.created on copy B',
    );
    const created = leadSock.events.find((e) => e.event === 'ticket.created');
    process.stderr.write(
      `[acc14] mail -> new ticket visible on the other copy after ${Math.round((created?.at ?? 0) - t0)} ms (includes mail processing)\n`,
    );
    const ticketId = (created?.payload as { ticket: { id: string } }).ticket.id;
    await eventually(
      async () =>
        agentSock.events.find(
          (e) =>
            e.event === 'ticket.updated' &&
            (e.payload as { ticket: { assigneeId: string | null } }).ticket.assigneeId !== null,
        ),
      20_000,
      'assignment visible to the agent',
    );
    const t1 = performance.now();
    expect(
      (await agentA.client.put(`/api/v1/tickets/${ticketId}/status`, { status: 'resolved' }))
        .status,
    ).toBe(200);
    const seen = await eventually(
      async () =>
        leadSock.events.find(
          (e) =>
            e.event === 'ticket.updated' &&
            (e.payload as { ticket: { status: string } }).ticket.status === 'resolved',
        ),
      5000,
      'status change on copy B',
    );
    const latency = seen.at - t1;
    process.stderr.write(
      `[acc14] status change visible on the other copy after ${Math.round(latency)} ms\n`,
    );
    expect(latency).toBeLessThan(1000);
    leadSock.close();
    agentSock.close();
  });
});
