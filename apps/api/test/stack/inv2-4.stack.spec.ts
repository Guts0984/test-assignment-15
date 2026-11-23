import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createTeam,
  customersOf,
  eventually,
  inject,
  setChaos,
  setClock,
  stackDb,
  stubMail,
  uniq,
  urls,
} from './stack';

const db = stackDb();
afterAll(async () => db.$disconnect());
afterEach(async () => {
  await setChaos(false);
  await setClock({ offsetMs: 0 });
});

const ticketFor = async (teamId: string, from: string) =>
  eventually(
    async () => db.ticket.findFirst({ where: { teamId, customer: { email: from } } }),
    60_000,
    `ticket for ${from}`,
  );

describe('ACC-7 / INV-2: auto-assignment, lead transfer and take-it at the same moment', () => {
  it('ends with one owner and an honest history, 30 rounds through nginx', async () => {
    const team = await createTeam({ agents: 3, limit: 100 });
    // keep the queue unattended so the race is between the three actors only
    await Promise.all(team.agents.map((a) => a.client.put('/api/v1/me/shift', { onShift: false })));
    const [a, b, c] = team.agents;
    for (let i = 0; i < 30; i += 1) {
      const from = `${uniq('own')}@customer.test`;
      await inject({ from, to: team.mailbox, subject: `Race ${i}`, text: 'x' });
      const t = await ticketFor(team.teamId, from);
      await Promise.all([
        c?.client.put('/api/v1/me/shift', { onShift: true }), // wakes the auto-assigner
        a?.client.post(`/api/v1/tickets/${t.id}/take`, {}),
        team.lead.client.post(`/api/v1/tickets/${t.id}/transfer`, { assigneeId: b?.id }),
      ]);
      await c?.client.put('/api/v1/me/shift', { onShift: false });
      await eventually(
        async () => (await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).assigneeId,
        30_000,
        'owner',
      );
      const events = await db.ticketEvent.findMany({
        where: { ticketId: t.id, type: { in: ['taken', 'assigned', 'transferred'] } },
        orderBy: { id: 'asc' },
      });
      const owner = (await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).assigneeId;
      const last = events[events.length - 1];
      const named =
        last?.type === 'taken'
          ? (last.data as { by: string }).by
          : last?.type === 'transferred'
            ? (last.data as { to: string }).to
            : (last?.data as { assigneeId: string }).assigneeId;
      expect(named, `round ${i}`).toBe(owner);
      expect(events.length).toBeLessThanOrEqual(3);
    }
    for (const u of team.agents) {
      const real = await db.ticket.count({
        where: { assigneeId: u.id, status: { in: ['new', 'open', 'waiting_customer', 'on_hold'] } },
      });
      expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).openCount).toBe(real);
    }
  });
});

describe('ACC-8 / INV-4: mail chaos (double delivery, SMTP errors, autoreplies)', () => {
  it('creates each ticket once, sends every email to the customer exactly once and lets no autoreply open a ticket', async () => {
    const team = await createTeam({ agents: 2, limit: 100 });
    await setChaos(true);
    const senders = customersOf(uniq('chaos'), 40);
    await Promise.all(
      senders.map((from, i) =>
        inject({ from, to: team.mailbox, subject: `Chaos ${i}`, text: 'help' }),
      ),
    );
    await eventually(
      async () => (await db.ticket.count({ where: { teamId: team.teamId } })) === 40,
      90_000,
      '40 tickets',
    );
    await eventually(
      async () =>
        (await db.outboundEmail.count({
          where: { ticket: { teamId: team.teamId }, state: 'sent' },
        })) === 40,
      120_000,
      '40 acknowledgements sent',
    );
    await new Promise((r) => setTimeout(r, 4000)); // let autoreplies and bounces come back and be processed
    expect(await db.ticket.count({ where: { teamId: team.teamId } })).toBe(40);
    expect(
      await db.message.count({
        where: {
          ticket: { teamId: team.teamId },
          direction: 'inbound',
          kind: 'public',
          autoKind: null,
        },
      }),
    ).toBe(40); // double delivery counted once
    expect(
      await db.inboundMessage.count({ where: { mailboxAddress: team.mailbox, state: 'pending' } }),
    ).toBe(0);
    const sent = await db.outboundEmail.findMany({ where: { ticket: { teamId: team.teamId } } });
    const received = await stubMail({ limit: 5000 });
    for (const row of sent) {
      const hits = received.filter((m) => m.messageId === `<${row.rfcMessageId}>`).length;
      expect(hits, row.rfcMessageId).toBe(1); // counted at the receiving stub, not in the database
    }
    const stats = (await (await fetch(`${urls.stub}/api/stats`)).json()) as { failed: number };
    expect(stats.failed).toBeGreaterThan(0); // the 451 errors really happened
    const autos = await db.message.count({
      where: { ticket: { teamId: team.teamId }, autoKind: { not: null } },
    });
    expect(autos).toBeGreaterThan(0);
    for (const t of await db.ticket.findMany({ where: { teamId: team.teamId } }))
      expect(['new', 'open']).toContain(t.status); // no reopen, no extra tickets
  });
});
