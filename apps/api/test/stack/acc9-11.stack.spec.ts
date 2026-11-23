import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTeam, eventually, inject, setClock, stackDb, stubMail, uniq } from './stack';

const db = stackDb();
afterAll(async () => db.$disconnect());
afterEach(async () => setClock({ offsetMs: 0 }));

const DAY = 86_400_000;
const arrive = async (
  team: Awaited<ReturnType<typeof createTeam>>,
  from: string,
  subject = 'Question',
) => {
  await inject({ from, to: team.mailbox, subject, text: 'hello' });
  return eventually(
    async () =>
      db.ticket.findFirst({
        where: { teamId: team.teamId, customer: { email: from } },
        orderBy: { createdAt: 'desc' },
      }),
    60_000,
    'ticket',
  );
};

describe('ACC-9: a reply to a six-month-old mail of a closed ticket opens a new ticket linked to the old one', () => {
  it('creates a follow-up ticket, not a message in the closed one', async () => {
    const team = await createTeam({ agents: 1, limit: 10 });
    const from = `${uniq('old')}@customer.test`;
    const old = await arrive(team, from);
    const ack = await eventually(
      async () =>
        db.outboundEmail.findFirst({
          where: { ticketId: old.id, purpose: 'acknowledgement', state: 'sent' },
        }),
      60_000,
      'ack sent',
    );
    await db.ticket.update({
      where: { id: old.id },
      data: { status: 'closed', closedAt: new Date() },
    });
    await setClock({ advanceMs: 183 * DAY });
    await inject({
      from,
      to: team.mailbox,
      subject: 'Re: Question',
      text: 'it is back',
      inReplyTo: ack.rfcMessageId,
    });
    const follow = await eventually(
      async () => db.ticket.findFirst({ where: { followUpOfId: old.id } }),
      60_000,
      'follow-up ticket',
    );
    expect(follow.id).not.toBe(old.id);
    expect(await db.message.count({ where: { ticketId: old.id } })).toBe(1);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('closed');
  });
});

describe('ACC-10: undo send', () => {
  it('a reply cancelled inside the window never reaches the customer; one left alone is delivered once', async () => {
    const team = await createTeam({ agents: 1, limit: 10 });
    const agent = team.agents[0];
    const from = `${uniq('undo')}@customer.test`;
    const t = await arrive(team, from);
    await eventually(
      async () =>
        (await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).assigneeId === agent?.id,
      30_000,
      'assigned',
    );
    const reply = (
      await agent?.client.post(`/api/v1/tickets/${t.id}/replies`, {
        body: 'CANCELLED-REPLY',
        lastSeenSeq: 1,
      })
    )?.json as { messageId: string };
    await setClock({ advanceMs: 9_000 }); // 9 s of the 10 s window have passed by the shared clock
    expect(
      (await agent?.client.del(`/api/v1/tickets/${t.id}/replies/${reply.messageId}`))?.status,
    ).toBe(200);
    await setClock({ advanceMs: 5 * 60_000 });
    await new Promise((r) => setTimeout(r, 5000));
    expect(
      (await stubMail({ to: from })).filter((m) => m.text.includes('CANCELLED-REPLY')),
    ).toHaveLength(0);

    const kept = (
      await agent?.client.post(`/api/v1/tickets/${t.id}/replies`, {
        body: 'DELIVERED-REPLY',
        lastSeenSeq: 1,
      })
    )?.json as { messageId: string };
    await setClock({ advanceMs: 10_500 });
    const late = await agent?.client.del(`/api/v1/tickets/${t.id}/replies/${kept.messageId}`);
    expect(late?.status).toBe(409);
    await eventually(
      async () =>
        (await stubMail({ to: from })).filter((m) => m.text.includes('DELIVERED-REPLY')).length ===
        1
          ? true
          : false,
      60_000,
      'reply delivered once',
    );
    await new Promise((r) => setTimeout(r, 3000));
    expect(
      (await stubMail({ to: from })).filter((m) => m.text.includes('DELIVERED-REPLY')),
    ).toHaveLength(1);
  });
});

describe('ACC-11: simultaneous merge A->B and B->A', () => {
  it('produces exactly one merge and loses no message', async () => {
    const team = await createTeam({ agents: 1, limit: 50 });
    const agent = team.agents[0];
    for (let round = 0; round < 5; round += 1) {
      const from = `${uniq('merge')}@customer.test`;
      const a = await arrive(team, from, `First ${round}`);
      await inject({ from, to: team.mailbox, subject: `Second ${round}`, text: 'again' });
      const b = await eventually(
        async () =>
          await db.ticket.findFirst({
            where: { teamId: team.teamId, customer: { email: from }, subject: `Second ${round}` },
          }),
        60_000,
        'second ticket',
      );
      const results = await Promise.all([
        agent?.client.post(`/api/v1/tickets/${a.id}/merge`, { targetTicketId: b.id }),
        agent?.client.post(`/api/v1/tickets/${b.id}/merge`, { targetTicketId: a.id }),
      ]);
      expect(results.map((r) => r?.status).sort()).toEqual([200, 409]);
      const rows = await db.ticket.findMany({ where: { id: { in: [a.id, b.id] } } });
      expect(rows.filter((r) => r.mergedIntoId !== null)).toHaveLength(1);
      const main = rows.find((r) => r.mergedIntoId === null);
      expect(
        await db.message.count({
          where: { ticketId: main?.id, kind: 'public', direction: 'inbound' },
        }),
      ).toBe(2);
    }
  });
});
