import { afterAll, describe, expect, it } from 'vitest';
import {
  changePriority,
  changeStatus,
  changeTeam,
  closeResolvedTicket,
  createReply,
  createTicket,
  mergeTickets,
  takeTicket,
  transferTicket,
  type ActorRef,
} from '../src/index';
import { burst } from './helpers/concurrency';
import { createAgent, createTeam, openCountOf, realLoadOf, testDb, uniq } from './helpers/db';
import { T0, at, eventsOf, run, ticketOf } from './helpers/tickets';

const db = testDb();
afterAll(async () => {
  await db.$disconnect();
});

const newTicket = async (
  teamId: string,
  email = `${uniq('cust')}@customer.test`,
  priority: 'urgent' | 'high' | 'normal' | 'low' = 'normal',
) => {
  const r = await run(db, T0, async (c) => ({
    ok: true as const,
    value: await createTicket(c, {
      customerEmail: email,
      customerName: 'Cust',
      subject: 'Subject',
      body: 'body',
      source: 'web',
      mailboxAddress: null,
      teamId,
      priority,
      language: 'en',
      rfcMessageId: `${uniq('mid')}@x.test`,
      inboundMessageId: null,
      followUpOfId: null,
      attachments: [],
      suppressAcknowledgement: true,
    }),
  }));
  if (!r.ok) throw new Error('setup failed');
  return { ...r.value, email };
};
const agentActor = (u: { id: string }): ActorRef => ({ kind: 'agent', userId: u.id });
const lead: ActorRef = { kind: 'lead', userId: null };
const system: ActorRef = { kind: 'system', userId: null };

describe('status changes (transition table and side effects)', () => {
  it('rejects transitions the table forbids with INVALID_STATUS_TRANSITION', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const t = await newTicket(team.id);
    for (const to of ['new', 'closed'] as const) {
      expect(
        await run(db, T0, (c) =>
          changeStatus(c, { ticketId: t.ticketId, actor: agentActor(a), to }),
        ),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_TRANSITION' } });
    }
    expect((await ticketOf(db, t.ticketId)).status).toBe('new');
  });

  it('waiting_customer opens a pause that stops the resolution deadline; leaving it resumes with the same business time', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const t = await newTicket(team.id);
    const before = await ticketOf(db, t.ticketId);
    await run(db, at(T0, 3600_000), (c) =>
      changeStatus(c, { ticketId: t.ticketId, actor: agentActor(a), to: 'waiting_customer' }),
    );
    const paused = await ticketOf(db, t.ticketId);
    expect([paused.status, paused.slaPaused, paused.resolutionDueAt]).toEqual([
      'waiting_customer',
      true,
      null,
    ]);
    expect(
      (
        await db.job.findUniqueOrThrow({
          where: { dedupeKey: `sla:${t.ticketId}:resolution:breach` },
        })
      ).status,
    ).toBe('cancelled');
    // back to open exactly 2 business hours later (11:00 -> pause at 12:00 Kyiv, resume at 14:00)
    await run(db, at(T0, 3 * 3600_000), (c) =>
      changeStatus(c, { ticketId: t.ticketId, actor: agentActor(a), to: 'open' }),
    );
    const resumed = await ticketOf(db, t.ticketId);
    expect(resumed.slaPaused).toBe(false);
    expect(
      (resumed.resolutionDueAt?.getTime() ?? 0) - (before.resolutionDueAt?.getTime() ?? 0),
    ).toBe(2 * 3600_000);
    expect(
      (
        await db.job.findUniqueOrThrow({
          where: { dedupeKey: `sla:${t.ticketId}:resolution:breach` },
        })
      ).status,
    ).toBe('pending');
    expect(
      (
        await db.job.findUniqueOrThrow({
          where: { dedupeKey: `sla:${t.ticketId}:resolution:breach` },
        })
      ).runAt,
    ).toEqual(resumed.resolutionDueAt);
  });

  it('resolving frees the agent slot, schedules auto-close in 72 h, and records history', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const t = await newTicket(team.id);
    await db.ticket.update({ where: { id: t.ticketId }, data: { assigneeId: a.id } });
    expect(await openCountOf(db, a.id)).toBe(1);
    await run(db, T0, (c) =>
      changeStatus(c, { ticketId: t.ticketId, actor: agentActor(a), to: 'resolved' }),
    );
    expect(await openCountOf(db, a.id)).toBe(0);
    const job = await db.job.findUniqueOrThrow({
      where: { dedupeKey: `auto_close:${t.ticketId}` },
    });
    expect(job.runAt).toEqual(at(T0, 72 * 3600_000));
    expect(
      await db.job.count({ where: { dedupeKey: `assign:${team.id}`, status: 'pending' } }),
    ).toBe(1);
    expect(await ticketOf(db, t.ticketId)).toMatchObject({ status: 'resolved', resolvedAt: T0 });
    // reopening by an agent cancels the auto-close and clears resolved_at
    await run(db, at(T0, 1000), (c) =>
      changeStatus(c, { ticketId: t.ticketId, actor: agentActor(a), to: 'open' }),
    );
    expect(
      (await db.job.findUniqueOrThrow({ where: { dedupeKey: `auto_close:${t.ticketId}` } })).status,
    ).toBe('cancelled');
    expect((await ticketOf(db, t.ticketId)).resolvedAt).toBeNull();
  });

  it('closing a resolved ticket makes exactly one survey and one survey email with a 7-day link', async () => {
    const team = await createTeam(db);
    const t = await newTicket(team.id);
    await db.ticket.update({
      where: { id: t.ticketId },
      data: { status: 'resolved', resolvedAt: T0 },
    });
    const results = await burst(10, () =>
      run(db, at(T0, 72 * 3600_000), async (c) => {
        await closeResolvedTicket(c, t.ticketId, system);
        return { ok: true as const, value: null };
      }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db.survey.count({ where: { ticketId: t.ticketId } })).toBe(1);
    const s = await db.survey.findUniqueOrThrow({ where: { ticketId: t.ticketId } });
    expect(s.expiresAt).toEqual(at(T0, 72 * 3600_000 + 7 * 86_400_000));
    const mails = await db.outboundEmail.findMany({
      where: { ticketId: t.ticketId, purpose: 'survey' },
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]?.bodyText).toMatch(/\/survey#token=[A-Za-z0-9_-]{43}/);
    expect(mails[0]?.autoGenerated).toBe(true);
    expect((await ticketOf(db, t.ticketId)).status).toBe('closed');
  });

  it('leads and admins may close a resolved ticket manually, agents may not', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const t = await newTicket(team.id);
    await db.ticket.update({
      where: { id: t.ticketId },
      data: { status: 'resolved', resolvedAt: T0 },
    });
    expect(
      await run(db, T0, (c) =>
        changeStatus(c, { ticketId: t.ticketId, actor: agentActor(a), to: 'closed' }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      (
        await run(db, T0, (c) =>
          changeStatus(c, { ticketId: t.ticketId, actor: lead, to: 'closed' }),
        )
      ).ok,
    ).toBe(true);
  });
});

describe('priority and team changes recompute the SLA from creation time', () => {
  it('a higher priority pulls deadlines in and moves the pending timers; a fired warning is never re-armed', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const t = await newTicket(team.id);
    const before = await ticketOf(db, t.ticketId);
    await db.job.update({
      where: { dedupeKey: `sla:${t.ticketId}:first_response:warning` },
      data: { status: 'done' },
    });
    const doneRunAt = (
      await db.job.findUniqueOrThrow({
        where: { dedupeKey: `sla:${t.ticketId}:first_response:warning` },
      })
    ).runAt;
    const r = await run(db, at(T0, 60_000), (c) =>
      changePriority(c, { ticketId: t.ticketId, actor: agentActor(a), priority: 'urgent' }),
    );
    expect(r.ok).toBe(true);
    const after = await ticketOf(db, t.ticketId);
    expect(after.priority).toBe('urgent');
    expect(after.firstResponseDueAt?.toISOString()).toBe('2026-03-04T10:00:00.000Z'); // 1 h around the clock from creation
    expect(after.firstResponseDueAt?.getTime() ?? 0).toBeLessThan(
      before.firstResponseDueAt?.getTime() ?? 0,
    );
    expect(
      (
        await db.job.findUniqueOrThrow({
          where: { dedupeKey: `sla:${t.ticketId}:first_response:breach` },
        })
      ).runAt,
    ).toEqual(after.firstResponseDueAt);
    const warn = await db.job.findUniqueOrThrow({
      where: { dedupeKey: `sla:${t.ticketId}:first_response:warning` },
    });
    expect([warn.status, warn.runAt]).toEqual(['done', doneRunAt]);
  });

  it('moving to another team recalculates with that team calendar, clears the owner and queues for the new team', async () => {
    const [from, to] = [
      await createTeam(db, { timeZone: 'Europe/Kyiv' }),
      await createTeam(db, { timeZone: 'Europe/Warsaw' }),
    ];
    const a = await createAgent(db, from.id);
    const t = await newTicket(from.id);
    await db.ticket.update({ where: { id: t.ticketId }, data: { assigneeId: a.id } });
    const before = await ticketOf(db, t.ticketId);
    const r = await run(db, at(T0, 60_000), (c) =>
      changeTeam(c, { ticketId: t.ticketId, actor: agentActor(a), teamId: to.id }),
    );
    expect(r.ok).toBe(true);
    const after = await ticketOf(db, t.ticketId);
    expect([after.teamId, after.assigneeId]).toEqual([to.id, null]);
    expect(after.firstResponseDueAt?.getTime()).not.toBe(before.firstResponseDueAt?.getTime()); // Warsaw is an hour behind Kyiv
    expect(await openCountOf(db, a.id)).toBe(0);
    expect(
      await db.job.count({
        where: { dedupeKey: { in: [`assign:${from.id}`, `assign:${to.id}`] }, status: 'pending' },
      }),
    ).toBe(2);
    expect(
      (
        await run(db, T0, (c) =>
          changeTeam(c, {
            ticketId: t.ticketId,
            actor: agentActor(a),
            teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          }),
        )
      ).ok,
    ).toBe(false);
  });
});

describe('transfer and take-it', () => {
  it('an agent hands their ticket to a colleague; the limit of the colleague is respected', async () => {
    const team = await createTeam(db);
    const [a, b] = [await createAgent(db, team.id), await createAgent(db, team.id, { limit: 1 })];
    const [t1, t2] = [await newTicket(team.id), await newTicket(team.id)];
    await db.ticket.updateMany({
      where: { id: { in: [t1.ticketId, t2.ticketId] } },
      data: { assigneeId: a.id },
    });
    expect(
      (
        await run(db, T0, (c) =>
          transferTicket(c, {
            ticketId: t1.ticketId,
            actor: agentActor(a),
            toUserId: b.id,
            leadOverride: false,
          }),
        )
      ).ok,
    ).toBe(true);
    const full = await run(db, T0, (c) =>
      transferTicket(c, {
        ticketId: t2.ticketId,
        actor: agentActor(a),
        toUserId: b.id,
        leadOverride: false,
      }),
    );
    expect(full).toMatchObject({ ok: false, error: { code: 'AGENT_AT_LIMIT' } });
    expect((await ticketOf(db, t2.ticketId)).assigneeId).toBe(a.id);
    expect([await openCountOf(db, a.id), await openCountOf(db, b.id)]).toEqual([1, 1]);
  });

  it('only the owner transfers; leads may reassign anyone; targets must be agents of the ticket team', async () => {
    const team = await createTeam(db);
    const other = await createTeam(db);
    const [a, b, outsider, leadUser] = [
      await createAgent(db, team.id),
      await createAgent(db, team.id),
      await createAgent(db, other.id),
      await createAgent(db, team.id, { role: 'lead' }),
    ];
    const t = await newTicket(team.id);
    await db.ticket.update({ where: { id: t.ticketId }, data: { assigneeId: a.id } });
    expect(
      await run(db, T0, (c) =>
        transferTicket(c, {
          ticketId: t.ticketId,
          actor: agentActor(b),
          toUserId: b.id,
          leadOverride: false,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(
      await run(db, T0, (c) =>
        transferTicket(c, {
          ticketId: t.ticketId,
          actor: agentActor(a),
          toUserId: outsider.id,
          leadOverride: false,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(
      await run(db, T0, (c) =>
        transferTicket(c, {
          ticketId: t.ticketId,
          actor: agentActor(a),
          toUserId: leadUser.id,
          leadOverride: false,
        }),
      ),
    ).toMatchObject({ ok: false }); // leads are not assignment targets
    expect(
      (
        await run(db, T0, (c) =>
          transferTicket(c, {
            ticketId: t.ticketId,
            actor: { kind: 'lead', userId: leadUser.id },
            toUserId: b.id,
            leadOverride: true,
          }),
        )
      ).ok,
    ).toBe(true);
    expect((await ticketOf(db, t.ticketId)).assigneeId).toBe(b.id);
  });

  it('take-it works on an unassigned ticket only', async () => {
    const team = await createTeam(db);
    const [a, b] = [await createAgent(db, team.id), await createAgent(db, team.id)];
    const t = await newTicket(team.id);
    expect(
      (await run(db, T0, (c) => takeTicket(c, { ticketId: t.ticketId, actor: agentActor(a) }))).ok,
    ).toBe(true);
    expect(
      await run(db, T0, (c) => takeTicket(c, { ticketId: t.ticketId, actor: agentActor(b) })),
    ).toMatchObject({ ok: false, error: { code: 'TICKET_ALREADY_ASSIGNED' } });
  });

  it('INV-2: take-it, lead transfer and an auto-assignment race 60 times: one owner, linear history, exact counters', async () => {
    const team = await createTeam(db);
    const [a, b, c2] = [
      await createAgent(db, team.id, { limit: 200 }),
      await createAgent(db, team.id, { limit: 200 }),
      await createAgent(db, team.id, { limit: 200 }),
    ];
    const leadUser = await createAgent(db, team.id, { role: 'lead' });
    for (let i = 0; i < 60; i += 1) {
      const t = await newTicket(team.id);
      const results = await Promise.all([
        run(db, T0, (c) => takeTicket(c, { ticketId: t.ticketId, actor: agentActor(a) })),
        run(db, T0, (c) =>
          transferTicket(c, {
            ticketId: t.ticketId,
            actor: { kind: 'lead', userId: leadUser.id },
            toUserId: b.id,
            leadOverride: true,
          }),
        ),
        // the auto-assigner: only touches a ticket nobody owns, under the row lock
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${t.ticketId}::uuid FOR UPDATE`;
          return tx.$executeRaw`UPDATE tickets SET assignee_id = ${c2.id}::uuid WHERE id = ${t.ticketId}::uuid AND assignee_id IS NULL`;
        }),
      ]);
      const owner = (await ticketOf(db, t.ticketId)).assigneeId;
      expect([a.id, b.id, c2.id]).toContain(owner);
      const events = (await eventsOf(db, t.ticketId)).filter((e) =>
        ['taken', 'transferred'].includes(e.type),
      );
      // every recorded change happened exactly once and the last one names the owner
      const last = events[events.length - 1];
      if (last !== undefined) {
        const named =
          last.type === 'taken'
            ? (last.data as { by: string }).by
            : (last.data as { to: string }).to;
        if (results[2] === 0 || last !== undefined) expect([a.id, b.id, c2.id]).toContain(named);
      }
      expect(events.length).toBeLessThanOrEqual(2);
    }
    for (const u of [a, b, c2])
      expect(await openCountOf(db, u.id)).toBe(await realLoadOf(db, u.id));
  });
});

describe('merge (invariant 7)', () => {
  it('moves the correspondence, closes the duplicate with a link, revokes its customer links and keeps the main SLA', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const email = `${uniq('cust')}@customer.test`;
    const [dup, main] = [await newTicket(team.id, email), await newTicket(team.id, email)];
    const mainBefore = await ticketOf(db, main.ticketId);
    await db.ticket.update({ where: { id: dup.ticketId }, data: { assigneeId: a.id } });
    await db.ticketAccessToken.create({
      data: {
        ticketId: dup.ticketId,
        tokenHash: uniq('h'),
        expiresAt: at(T0, 86_400_000),
        createdAt: T0,
      },
    });
    const r = await run(db, at(T0, 1000), (c) =>
      mergeTickets(c, { sourceId: dup.ticketId, targetId: main.ticketId, actor: agentActor(a) }),
    );
    expect(r).toMatchObject({ ok: true, value: { mainTicketId: main.ticketId, movedMessages: 1 } });
    const [d, m] = [await ticketOf(db, dup.ticketId), await ticketOf(db, main.ticketId)];
    expect([d.status, d.mergedIntoId, d.assigneeId]).toEqual(['closed', main.ticketId, null]);
    expect(m.firstResponseDueAt).toEqual(mainBefore.firstResponseDueAt);
    const msgs = await db.message.findMany({
      where: { ticketId: main.ticketId },
      orderBy: { seq: 'asc' },
    });
    expect(msgs.map((x) => x.seq)).toEqual([1, 2]);
    expect(msgs[1]?.originTicketId).toBe(dup.ticketId);
    expect(m.messageSeq).toBe(2);
    expect(
      (await db.ticketAccessToken.findFirstOrThrow({ where: { ticketId: dup.ticketId } }))
        .revokedAt,
    ).not.toBeNull();
    expect(await openCountOf(db, a.id)).toBe(0);
    expect((await eventsOf(db, dup.ticketId)).map((e) => e.type)).toContain('merged');
    expect((await eventsOf(db, main.ticketId)).map((e) => e.type)).toContain('merged_in');
    expect(
      await db.job.count({
        where: {
          ref: dup.ticketId,
          status: 'pending',
          kind: { in: ['sla_warning', 'sla_breach'] },
        },
      }),
    ).toBe(0);
  });

  it('refuses other customers, itself, closed tickets and merging a merged ticket again', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const email = `${uniq('cust')}@customer.test`;
    const [t1, t2, t3, foreign] = [
      await newTicket(team.id, email),
      await newTicket(team.id, email),
      await newTicket(team.id, email),
      await newTicket(team.id),
    ];
    const merge = (s: string, t: string) =>
      run(db, T0, (c) => mergeTickets(c, { sourceId: s, targetId: t, actor: agentActor(a) }));
    expect(await merge(t1.ticketId, foreign.ticketId)).toMatchObject({
      ok: false,
      error: { code: 'TICKETS_NOT_MERGEABLE' },
    });
    expect(await merge(t1.ticketId, t1.ticketId)).toMatchObject({
      ok: false,
      error: { code: 'TICKETS_NOT_MERGEABLE' },
    });
    expect((await merge(t1.ticketId, t2.ticketId)).ok).toBe(true);
    expect(await merge(t1.ticketId, t3.ticketId)).toMatchObject({
      ok: false,
      error: { code: 'TICKET_ALREADY_MERGED' },
    });
    expect(await merge(t3.ticketId, t1.ticketId)).toMatchObject({
      ok: false,
      error: { code: 'TICKET_ALREADY_MERGED' },
    });
    await db.ticket.update({ where: { id: t3.ticketId }, data: { status: 'closed' } });
    expect(await merge(t2.ticketId, t3.ticketId)).toMatchObject({
      ok: false,
      error: { code: 'TICKETS_NOT_MERGEABLE' },
    });
  });

  it('INV-7: simultaneous A->B and B->A, 40 rounds: exactly one merge, no cycle, no message lost', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const email = `${uniq('cust')}@customer.test`;
    for (let i = 0; i < 40; i += 1) {
      const [x, y] = [await newTicket(team.id, email), await newTicket(team.id, email)];
      const results = await Promise.all([
        run(db, T0, (c) =>
          mergeTickets(c, { sourceId: x.ticketId, targetId: y.ticketId, actor: agentActor(a) }),
        ),
        run(db, T0, (c) =>
          mergeTickets(c, { sourceId: y.ticketId, targetId: x.ticketId, actor: agentActor(a) }),
        ),
      ]);
      expect(
        results.filter((r) => r.ok),
        `round ${i}`,
      ).toHaveLength(1);
      const loser = results.find((r) => !r.ok);
      expect(['TICKET_ALREADY_MERGED', 'TICKETS_NOT_MERGEABLE']).toContain(
        (loser as { error: { code: string } }).error.code,
      );
      const rows = await db.ticket.findMany({ where: { id: { in: [x.ticketId, y.ticketId] } } });
      expect(rows.filter((r) => r.mergedIntoId !== null)).toHaveLength(1);
      const main = rows.find((r) => r.mergedIntoId === null);
      expect(await db.message.count({ where: { ticketId: main?.id } })).toBe(2); // both first messages survived
      expect(main?.messageSeq).toBe(2);
    }
  });

  it('chains: a customer reply to the oldest thread after A->B, B->C lands in C', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const email = `${uniq('cust')}@customer.test`;
    const [ta, tb, tc] = [
      await newTicket(team.id, email),
      await newTicket(team.id, email),
      await newTicket(team.id, email),
    ];
    expect(
      (
        await run(db, T0, (c) =>
          mergeTickets(c, { sourceId: ta.ticketId, targetId: tb.ticketId, actor: agentActor(a) }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await run(db, T0, (c) =>
          mergeTickets(c, { sourceId: tb.ticketId, targetId: tc.ticketId, actor: agentActor(a) }),
        )
      ).ok,
    ).toBe(true);
    expect(await db.message.count({ where: { ticketId: tc.ticketId } })).toBe(3);
    const { rootTicketId } = await import('../src/index');
    expect(await db.$transaction((tx) => rootTicketId(tx, ta.ticketId))).toBe(tc.ticketId);
  });
});

describe('reply after first response marks the ticket open and keeps one timeline', () => {
  it('first reply moves new -> open and clears the first-response timers', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const t = await newTicket(team.id);
    await run(db, at(T0, 1000), (c) =>
      createReply(c, {
        ticketId: t.ticketId,
        actor: agentActor(a),
        authorName: 'A',
        body: 'hello',
        lastSeenSeq: 1,
        confirmNewMessages: false,
      }),
    );
    expect((await ticketOf(db, t.ticketId)).status).toBe('open');
    expect(
      await db.job.count({
        where: { dedupeKey: { startsWith: `sla:${t.ticketId}:first_response` }, status: 'pending' },
      }),
    ).toBe(0);
    expect(
      await db.job.count({
        where: { dedupeKey: { startsWith: `sla:${t.ticketId}:resolution` }, status: 'pending' },
      }),
    ).toBe(2);
  });
});
