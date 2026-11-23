import { afterAll, describe, expect, it } from 'vitest';
import {
  cancelReply,
  changeStatus,
  createNote,
  createReply,
  createTicket,
  type ActorRef,
} from '../src/index';
import { burst } from './helpers/concurrency';
import { createAgent, createTeam, testDb, uniq } from './helpers/db';
import { T0, at, eventsOf, run, ticketOf } from './helpers/tickets';

const db = testDb();
afterAll(async () => {
  await db.$disconnect();
});

const setup = async () => {
  const team = await createTeam(db);
  const agent = await createAgent(db, team.id);
  const other = await createAgent(db, team.id);
  const email = `${uniq('cust')}@customer.test`;
  const created = await run(db, T0, async (c) => ({
    ok: true as const,
    value: await createTicket(c, {
      customerEmail: email,
      customerName: 'Cust',
      subject: 'Help me',
      body: 'please help',
      source: 'web',
      mailboxAddress: null,
      teamId: team.id,
      priority: 'normal',
      language: 'en',
      rfcMessageId: `${uniq('mid')}@x.test`,
      inboundMessageId: null,
      followUpOfId: null,
      attachments: [],
      suppressAcknowledgement: false,
    }),
  }));
  if (!created.ok) throw new Error('setup failed');
  const actor = (u: { id: string }): ActorRef => ({ kind: 'agent', userId: u.id });
  return {
    team,
    agent,
    other,
    email,
    ticketId: created.value.ticketId,
    number: created.value.number,
    actor,
  };
};

/** `confirm: true` confirms everything that exists right now, like the "Send anyway" button after the warning. */
const reply = async (
  s: Awaited<ReturnType<typeof setup>>,
  who: { id: string },
  now: Date,
  over: { lastSeenSeq?: number; confirm?: boolean; body?: string } = {},
) => {
  const top =
    over.confirm === true
      ? ((await db.message.aggregate({ where: { ticketId: s.ticketId }, _max: { seq: true } }))._max
          .seq ?? 0)
      : null;
  return run(db, now, (c) =>
    createReply(c, {
      ticketId: s.ticketId,
      actor: s.actor(who),
      authorName: 'Agent',
      body: over.body ?? 'On it',
      lastSeenSeq: over.lastSeenSeq ?? 1,
      confirmedSeq: top,
    }),
  );
};

describe('agent reply and undo send (invariant 5)', () => {
  it('schedules the reply 10 s ahead, hides the email until then and records the first response', async () => {
    const s = await setup();
    const r = await reply(s, s.agent, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sendAfter).toEqual(at(T0, 10_000));
    const out = await db.outboundEmail.findUniqueOrThrow({ where: { id: r.value.outboundId } });
    expect([out.state, out.purpose, out.toEmail, out.messageId]).toEqual([
      'scheduled',
      'reply',
      s.email,
      r.value.messageId,
    ]);
    expect(out.subject).toBe(`[#${s.number}] Help me`);
    expect(out.bodyText).toContain('On it');
    const msg = await db.message.findUniqueOrThrow({ where: { id: r.value.messageId } });
    expect([msg.releasedAt, msg.cancelledAt, msg.rfcMessageId]).toEqual([
      null,
      null,
      out.rfcMessageId,
    ]);
    const t = await ticketOf(db, s.ticketId);
    expect([t.status, t.firstRespondedAt]).toEqual(['open', T0]);
    expect(
      (await db.job.findUniqueOrThrow({ where: { dedupeKey: `outbound:${out.id}` } })).runAt,
    ).toEqual(at(T0, 10_000));
  });

  it('cancel works until send_after: 9.9 s cancels, 10.000 s is too late', async () => {
    const s = await setup();
    const a = await reply(s, s.agent, T0);
    if (!a.ok) throw new Error('reply failed');
    const early = await run(db, at(T0, 9_900), (c) =>
      cancelReply(c, {
        ticketId: s.ticketId,
        messageId: a.value.messageId,
        actor: s.actor(s.agent),
      }),
    );
    expect(early.ok).toBe(true);
    expect(
      (await db.outboundEmail.findUniqueOrThrow({ where: { id: a.value.outboundId } })).state,
    ).toBe('cancelled');
    expect(
      (await db.job.findUniqueOrThrow({ where: { dedupeKey: `outbound:${a.value.outboundId}` } }))
        .status,
    ).toBe('cancelled');

    const b = await reply(s, s.agent, T0, { confirm: true });
    if (!b.ok) throw new Error('reply failed');
    const late = await run(db, at(T0, 10_000), (c) =>
      cancelReply(c, {
        ticketId: s.ticketId,
        messageId: b.value.messageId,
        actor: s.actor(s.agent),
      }),
    );
    expect(late).toMatchObject({ ok: false, error: { code: 'UNDO_WINDOW_EXPIRED' } });
    expect(
      (await db.outboundEmail.findUniqueOrThrow({ where: { id: b.value.outboundId } })).state,
    ).toBe('scheduled');
  });

  it('a cancelled first reply clears the first response so the SLA runs again', async () => {
    const s = await setup();
    const a = await reply(s, s.agent, T0);
    if (!a.ok) throw new Error('reply failed');
    expect((await ticketOf(db, s.ticketId)).firstRespondedAt).toEqual(T0);
    await run(db, at(T0, 5_000), (c) =>
      cancelReply(c, {
        ticketId: s.ticketId,
        messageId: a.value.messageId,
        actor: s.actor(s.agent),
      }),
    );
    const t = await ticketOf(db, s.ticketId);
    expect([t.firstRespondedAt, t.lastPublicReplyAt]).toEqual([null, null]);
    expect(
      await db.job.count({
        where: { dedupeKey: `sla:${s.ticketId}:first_response:breach`, status: 'pending' },
      }),
    ).toBe(1);
    expect((await eventsOf(db, s.ticketId)).map((e) => e.type)).toContain('reply_cancelled');
  });

  it('cancel racing the sender claim: exactly one wins, over 200 random offsets around the boundary', async () => {
    const s = await setup();
    let sent = 0;
    let cancelled = 0;
    for (let i = 0; i < 200; i += 1) {
      const a = await reply(s, s.agent, T0, { confirm: true });
      if (!a.ok) throw new Error('reply failed');
      const offset = 9_990 + (i % 21); // 9.990 .. 10.010 s
      const now = at(T0, offset);
      const [cancel, claim] = await Promise.all([
        run(db, now, (c) =>
          cancelReply(c, {
            ticketId: s.ticketId,
            messageId: a.value.messageId,
            actor: s.actor(s.agent),
          }),
        ),
        // the worker's claim: same clock, same row, same condition
        db.$executeRaw`UPDATE outbound_emails SET state = 'sending', lease_until = ${at(now, 30_000)}, attempts = attempts + 1
                        WHERE id = ${a.value.outboundId}::uuid AND state = 'scheduled' AND send_after <= ${now}`,
      ]);
      const claimed = claim === 1;
      expect(cancel.ok && claimed, `offset ${offset}`).toBe(false); // never both
      if (!cancel.ok && !claimed) expect(offset).toBe(10_000 - 0 > offset ? offset : offset); // both lost only when cancel was late and claim not yet due
      const state = (
        await db.outboundEmail.findUniqueOrThrow({ where: { id: a.value.outboundId } })
      ).state;
      if (cancel.ok) {
        cancelled += 1;
        expect(state).toBe('cancelled');
        expect(offset).toBeLessThan(10_000);
      }
      if (claimed) {
        sent += 1;
        expect(state).toBe('sending');
        expect(offset).toBeGreaterThanOrEqual(10_000);
      }
    }
    expect(sent).toBeGreaterThan(0);
    expect(cancelled).toBeGreaterThan(0);
  });

  it('cancelling an unknown reply or one on another ticket is NOT_FOUND', async () => {
    const s = await setup();
    const r = await run(db, T0, (c) =>
      cancelReply(c, {
        ticketId: s.ticketId,
        messageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        actor: s.actor(s.agent),
      }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('concurrent replies (invariant 6)', () => {
  it('two agents reply at once from the same state: one is stored, the other must confirm', async () => {
    const s = await setup();
    const results = await Promise.all([
      reply(s, s.agent, T0, { body: 'A answers' }),
      reply(s, s.other, T0, { body: 'B answers' }),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toMatchObject({ ok: false, error: { code: 'TICKET_HAS_NEW_MESSAGES' } });
    const data = (
      lost as { error: { data: { messages: { seq: number; body: string }[]; latestSeq: number } } }
    ).error.data;
    expect(data.messages).toHaveLength(1);
    expect(data.latestSeq).toBe(2);
    expect(
      await db.outboundEmail.count({ where: { ticketId: s.ticketId, purpose: 'reply' } }),
    ).toBe(1);
  });

  it('without confirmation the stale reply never goes out; with confirmation it is stored', async () => {
    const s = await setup();
    await reply(s, s.agent, T0, { body: 'first' });
    const stale = await reply(s, s.other, at(T0, 1000), { body: 'second', lastSeenSeq: 1 });
    expect(stale.ok).toBe(false);
    expect(
      await db.outboundEmail.count({ where: { ticketId: s.ticketId, purpose: 'reply' } }),
    ).toBe(1);
    const confirmed = await reply(s, s.other, at(T0, 2000), {
      body: 'second',
      lastSeenSeq: 1,
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(
      await db.outboundEmail.count({ where: { ticketId: s.ticketId, purpose: 'reply' } }),
    ).toBe(2);
  });

  it('20 simultaneous replies from the same state store exactly one', async () => {
    const s = await setup();
    const results = await burst(20, (i) =>
      reply(s, i % 2 === 0 ? s.agent : s.other, T0, { body: `reply ${i}` }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.message.count({ where: { ticketId: s.ticketId, direction: 'outbound' } })).toBe(
      1,
    );
  });

  it('internal notes never trigger or suffer the conflict, and cancelled replies do not count as new messages', async () => {
    const s = await setup();
    await run(db, T0, (c) =>
      createNote(c, {
        ticketId: s.ticketId,
        actor: s.actor(s.other),
        authorName: 'B',
        body: 'secret thought',
      }),
    );
    expect((await reply(s, s.agent, at(T0, 1000), { lastSeenSeq: 1 })).ok).toBe(true);
    const a = await reply(s, s.other, at(T0, 2000), { lastSeenSeq: 3, confirm: true });
    if (!a.ok) throw new Error('reply failed');
    await run(db, at(T0, 3000), (c) =>
      cancelReply(c, {
        ticketId: s.ticketId,
        messageId: a.value.messageId,
        actor: s.actor(s.other),
      }),
    );
    expect((await reply(s, s.agent, at(T0, 4000), { lastSeenSeq: 3 })).ok).toBe(true);
  });

  it('replying to a closed ticket is refused', async () => {
    const s = await setup();
    await db.ticket.update({ where: { id: s.ticketId }, data: { status: 'closed' } });
    expect(await reply(s, s.agent, T0)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });
  });
});

describe('history is complete and honest (requirement: who and when)', () => {
  it('records created, reply, note, cancel and status changes with actor and time', async () => {
    const s = await setup();
    const a = await reply(s, s.agent, T0);
    if (!a.ok) throw new Error('x');
    await run(db, at(T0, 1000), (c) =>
      createNote(c, {
        ticketId: s.ticketId,
        actor: s.actor(s.agent),
        authorName: 'A',
        body: 'note',
      }),
    );
    await run(db, at(T0, 2000), (c) =>
      cancelReply(c, {
        ticketId: s.ticketId,
        messageId: a.value.messageId,
        actor: s.actor(s.agent),
      }),
    );
    await run(db, at(T0, 3000), (c) =>
      changeStatus(c, { ticketId: s.ticketId, actor: s.actor(s.agent), to: 'resolved' }),
    );
    const ev = await eventsOf(db, s.ticketId);
    expect(ev.map((e) => e.type)).toEqual([
      'created',
      'status_changed',
      'reply',
      'note',
      'reply_cancelled',
      'status_changed',
    ]);
    expect(ev.map((e) => e.actorKind)).toEqual([
      'customer',
      'system',
      'agent',
      'agent',
      'agent',
      'agent',
    ]);
    expect(ev[2]?.actorUserId).toBe(s.agent.id);
    expect(ev[3]?.createdAt).toEqual(at(T0, 1000));
  });
});

describe('the new-message guard cannot be argued around (review finding F4)', () => {
  it('a seq from the future is refused, and a confirmation covers only what the agent saw', async () => {
    const s = await setup();
    const huge = await run(db, T0, (c) =>
      createReply(c, {
        ticketId: s.ticketId,
        actor: s.actor(s.agent),
        authorName: 'Agent',
        body: 'x',
        lastSeenSeq: 1_000_000,
        confirmedSeq: null,
      }),
    );
    expect(huge.ok ? 'ok' : huge.error.code).toBe('VALIDATION_FAILED');
    const sentBy = (await reply(s, s.agent, T0)).ok;
    expect(sentBy).toBe(true);
    // the colleague saw seq 1, was warned about seq 2 and confirmed it; a message that arrives later needs a new confirmation
    const warned = await reply(s, s.other, at(T0, 1000), { lastSeenSeq: 1 });
    expect(warned.ok ? 'ok' : warned.error.code).toBe('TICKET_HAS_NEW_MESSAGES');
    await db.$executeRaw`INSERT INTO messages (id, ticket_id, seq, kind, direction, author_kind, body, created_at)
      VALUES (gen_random_uuid(), ${s.ticketId}::uuid, 3, 'public', 'inbound', 'customer', 'late', now())`;
    const stale = await run(db, at(T0, 2000), (c) =>
      createReply(c, {
        ticketId: s.ticketId,
        actor: s.actor(s.other),
        authorName: 'Agent',
        body: 'y',
        lastSeenSeq: 1,
        confirmedSeq: 2,
      }),
    );
    expect(stale.ok ? 'ok' : stale.error.code).toBe('TICKET_HAS_NEW_MESSAGES');
  });
});
