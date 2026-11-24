import { afterAll, describe, expect, it } from 'vitest';
import {
  backoffMs,
  changeStatus,
  createReply,
  cancelReply,
  dueJobs,
  ensureDurableJobs,
  requestTeamAssignment,
  runOutboundJob,
  runTxJob,
  txHandlers,
  upsertJob,
  type RetryPolicy,
  type SendFn,
  type TxHandler,
} from '../src/index';
import { burst } from './helpers/concurrency';
import { createAgent, createTeam, testDb, uniq } from './helpers/db';
import { CFG, T0, at, eventsOf, newTicket, run, ticketOf } from './helpers/tickets';

const db = testDb();
afterAll(async () => {
  await db.$disconnect();
});

const policy: RetryPolicy = { baseMs: 1000, maxMs: 60_000, random: () => 1 };
const jobId = async (key: string): Promise<number> =>
  Number((await db.job.findUniqueOrThrow({ where: { dedupeKey: key } })).id);
const H = 3_600_000;

describe('INV-8: background jobs are reliable', () => {
  it('three runners claim the same job at once: the effect happens exactly once', async () => {
    const key = uniq('once');
    await upsertJob(db, { kind: 'assign_team', ref: 'x', dedupeKey: key, runAt: T0, now: T0 });
    const id = await jobId(key);
    let effects = 0;
    const handler: TxHandler = async () => {
      effects += 1;
      await new Promise((r) => setTimeout(r, 30));
      return undefined;
    };
    const outcomes = await burst(3, () => runTxJob(db, id, at(T0, 1), CFG, handler, policy));
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
    expect(effects).toBe(1);
    expect(await runTxJob(db, id, at(T0, 2), CFG, handler, policy)).toBe('skipped'); // a later duplicate does nothing
    expect(effects).toBe(1);
  });

  it('a job that is not due yet is left alone', async () => {
    const key = uniq('later');
    await upsertJob(db, {
      kind: 'assign_team',
      ref: 'x',
      dedupeKey: key,
      runAt: at(T0, 10_000),
      now: T0,
    });
    expect(await runTxJob(db, await jobId(key), T0, CFG, async () => undefined, policy)).toBe(
      'skipped',
    );
  });

  it('a failing job is retried with growing pauses, rolls its work back, and is dead (visible) after the last attempt', async () => {
    const key = uniq('fail');
    await upsertJob(db, {
      kind: 'assign_team',
      ref: 'x',
      dedupeKey: key,
      runAt: T0,
      now: T0,
      maxAttempts: 4,
    });
    const id = await jobId(key);
    const boom: TxHandler = async (c) => {
      await c.tx
        .$executeRaw`UPDATE jobs SET payload = '{"touched":true}'::jsonb WHERE id = ${BigInt(id)}`;
      throw new Error('SMTP connection refused');
    };
    let now = T0;
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await runTxJob(db, id, now, CFG, boom, policy)).toBe('retry');
      const j = await db.job.findUniqueOrThrow({ where: { id } });
      expect(j.status).toBe('pending');
      expect(j.lastError).toContain('connection refused');
      expect(j.payload).toEqual({}); // the failed attempt's own writes were rolled back
      expect(j.attempts).toBe(attempt + 1);
      gaps.push(j.runAt.getTime() - now.getTime());
      expect(await runTxJob(db, id, now, CFG, boom, policy)).toBe('skipped'); // not due until the backoff has passed
      now = j.runAt;
    }
    expect(gaps).toEqual([1000, 2000, 4000]);
    expect(await runTxJob(db, id, now, CFG, boom, policy)).toBe('dead');
    expect(await db.job.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'dead',
      attempts: 4,
    });
    expect(await runTxJob(db, id, at(now, H), CFG, boom, policy)).toBe('skipped'); // dead jobs do not run on their own
  });

  it('backoff is capped and jittered between 50% and 100%', () => {
    expect(backoffMs(30, { baseMs: 1000, maxMs: 60_000, random: () => 1 })).toBe(60_000);
    expect(backoffMs(2, { baseMs: 1000, maxMs: 60_000, random: () => 0 })).toBe(2000);
  });
});

describe('INV-3c: SLA warnings and breaches fire on time, once, in order, even after downtime', () => {
  const setup = async () => {
    const team = await createTeam(db);
    const lead = await createAgent(db, team.id, { role: 'lead' });
    const agent = await createAgent(db, team.id);
    const t = await newTicket(db, team.id, { priority: 'urgent' }); // 1 h first response, warning at 48 min
    const ticket = await ticketOf(db, t.ticketId);
    return { team, lead, agent, t, ticket };
  };
  const key = (id: string, event: string) => `sla:${id}:first_response:${event}`;

  it('the warning fires at 80% and the breach at the deadline, each exactly once', async () => {
    const s = await setup();
    await db.ticket.update({ where: { id: s.t.ticketId }, data: { assigneeId: s.agent.id } });
    const warnId = await jobId(key(s.t.ticketId, 'warning'));
    const breachId = await jobId(key(s.t.ticketId, 'breach'));
    const warnAt = s.ticket.firstResponseWarnAt as Date;
    const dueAt = s.ticket.firstResponseDueAt as Date;
    expect(warnAt.getTime() - T0.getTime()).toBe(48 * 60_000);
    expect(
      await runTxJob(db, warnId, at(warnAt, -1), CFG, txHandlers.sla_warning as TxHandler, policy),
    ).toBe('skipped');
    const results = await burst(3, () =>
      runTxJob(db, warnId, warnAt, CFG, txHandlers.sla_warning as TxHandler, policy),
    );
    expect(results.filter((r) => r === 'done')).toHaveLength(1);
    expect(
      await db.notification.count({ where: { ticketId: s.t.ticketId, kind: 'sla_warning' } }),
    ).toBe(1);
    expect(
      (await db.notification.findFirstOrThrow({ where: { ticketId: s.t.ticketId } })).userId,
    ).toBe(s.agent.id); // warning goes to the agent
    expect(
      await runTxJob(db, breachId, at(dueAt, -1), CFG, txHandlers.sla_breach as TxHandler, policy),
    ).toBe('skipped');
    await burst(3, () =>
      runTxJob(db, breachId, dueAt, CFG, txHandlers.sla_breach as TxHandler, policy),
    );
    const t = await ticketOf(db, s.t.ticketId);
    expect(t.firstResponseBreached).toBe(true);
    const types = (await eventsOf(db, s.t.ticketId))
      .map((e) => e.type)
      .filter((x) => x.startsWith('sla_'));
    expect(types).toEqual(['sla_warning', 'sla_breach']);
    const esc = await db.notification.findMany({
      where: { ticketId: s.t.ticketId, kind: 'sla_breach' },
    });
    expect(esc.map((n) => n.userId)).toEqual([s.lead.id]); // the breach escalates to the team lead
  });

  it('after hours of worker downtime both fire once, warning first, even if the breach job runs first', async () => {
    const s = await setup();
    const later = at(T0, 2 * H);
    const breachId = await jobId(key(s.t.ticketId, 'breach'));
    const warnId = await jobId(key(s.t.ticketId, 'warning'));
    await burst(2, () =>
      runTxJob(db, breachId, later, CFG, txHandlers.sla_breach as TxHandler, policy),
    );
    await burst(2, () =>
      runTxJob(db, warnId, later, CFG, txHandlers.sla_warning as TxHandler, policy),
    );
    const types = (await eventsOf(db, s.t.ticketId))
      .map((e) => e.type)
      .filter((x) => x.startsWith('sla_'));
    expect(types).toEqual(['sla_warning', 'sla_breach']);
    expect(
      await db.notification.count({ where: { ticketId: s.t.ticketId, kind: 'sla_warning' } }),
    ).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: warnId } })).status).toBe('done');
  });

  it('a ticket answered or resolved in time never warns or breaches', async () => {
    const s = await setup();
    await run(db, at(T0, 60_000), (c) =>
      createReply(c, {
        ticketId: s.t.ticketId,
        actor: { kind: 'agent', userId: s.agent.id },
        authorName: 'A',
        body: 'hi',
        lastSeenSeq: 1,
        confirmedSeq: null,
      }),
    );
    expect(
      await db.job.count({
        where: {
          dedupeKey: { in: [key(s.t.ticketId, 'warning'), key(s.t.ticketId, 'breach')] },
          status: 'pending',
        },
      }),
    ).toBe(0);
    const later = at(T0, 5 * H);
    const fr = await jobId(key(s.t.ticketId, 'breach'));
    expect(await runTxJob(db, fr, later, CFG, txHandlers.sla_breach as TxHandler, policy)).toBe(
      'skipped',
    ); // cancelled job
    expect((await ticketOf(db, s.t.ticketId)).firstResponseBreached).toBe(false);
  });

  it('after an undone first reply the timers run again and the breach fires', async () => {
    const s = await setup();
    const r = await run(db, at(T0, 1000), (c) =>
      createReply(c, {
        ticketId: s.t.ticketId,
        actor: { kind: 'agent', userId: s.agent.id },
        authorName: 'A',
        body: 'hi',
        lastSeenSeq: 1,
        confirmedSeq: null,
      }),
    );
    if (!r.ok) throw new Error('x');
    await run(db, at(T0, 5000), (c) =>
      cancelReply(c, {
        ticketId: s.t.ticketId,
        messageId: r.value.messageId,
        actor: { kind: 'agent', userId: s.agent.id },
      }),
    );
    const breachId = await jobId(key(s.t.ticketId, 'breach'));
    expect(
      await runTxJob(db, breachId, at(T0, 2 * H), CFG, txHandlers.sla_breach as TxHandler, policy),
    ).toBe('done');
    expect((await ticketOf(db, s.t.ticketId)).firstResponseBreached).toBe(true);
  });
});

describe('INV-4b / INV-5: outbound email is sent exactly once', () => {
  const setup = async () => {
    const team = await createTeam(db);
    const agent = await createAgent(db, team.id);
    const t = await newTicket(db, team.id);
    const r = await run(db, T0, (c) =>
      createReply(c, {
        ticketId: t.ticketId,
        actor: { kind: 'agent', userId: agent.id },
        authorName: 'A',
        body: 'Answer',
        lastSeenSeq: 1,
        confirmedSeq: null,
      }),
    );
    if (!r.ok) throw new Error('x');
    const job = await jobId(`outbound:${r.value.outboundId}`);
    return { team, agent, t, reply: r.value, job };
  };
  const send =
    (log: string[], script: Array<'ok' | 'transient' | 'permanent'> = []): SendFn =>
    async (m) => {
      const step = script.shift() ?? 'ok';
      if (step === 'transient')
        return { ok: false, transient: true, message: '451 4.3.0 try later' };
      if (step === 'permanent')
        return { ok: false, transient: false, message: '550 mailbox unavailable' };
      log.push(m.rfcMessageId);
      return { ok: true };
    };
  const go = (s: Awaited<ReturnType<typeof setup>>, now: Date, fn: SendFn) =>
    runOutboundJob(db, {
      jobId: s.job,
      outboundId: s.reply.outboundId,
      now,
      leaseMs: 30_000,
      maxAttempts: 8,
      defaultFrom: 'support@helpdesk.test',
      send: fn,
      policy,
    });

  it('is not sent before the undo window ends, then sent once and the reply becomes visible to the customer', async () => {
    const s = await setup();
    const log: string[] = [];
    expect(await go(s, at(T0, 9_999), send(log))).toBe('skipped');
    expect(log).toHaveLength(0);
    expect(await go(s, at(T0, 10_000), send(log))).toBe('done');
    expect(log).toHaveLength(1);
    expect(await go(s, at(T0, 11_000), send(log))).toBe('done');
    expect(log).toHaveLength(1);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: s.reply.messageId } })).releasedAt,
    ).toEqual(at(T0, 10_000));
    expect(
      (await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } })).state,
    ).toBe('sent');
  });

  it('a send cut off by a crash is not repeated when the delivery system already has the email (review F6)', async () => {
    const s = await setup();
    // a worker claimed the email and died: the row stays `sending` and its lease runs out
    await db.outboundEmail.update({
      where: { id: s.reply.outboundId },
      data: { state: 'sending', leaseUntil: at(T0, 20_000), attempts: 1 },
    });
    const log: string[] = [];
    const asked: string[] = [];
    const arrived = async (m: { rfcMessageId: string }): Promise<boolean> => {
      asked.push(m.rfcMessageId);
      return true;
    };
    const lookups = { lookup: arrived };
    const out = await runOutboundJob(db, {
      jobId: s.job,
      outboundId: s.reply.outboundId,
      now: at(T0, 40_000),
      leaseMs: 30_000,
      maxAttempts: 8,
      defaultFrom: 'support@helpdesk.test',
      send: send(log),
      policy,
      ...lookups,
    });
    expect(out).toBe('done');
    expect(log).toHaveLength(0); // never sent again
    expect(asked).toHaveLength(1);
    const row = await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } });
    expect(row.state).toBe('sent');
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: s.reply.messageId } })).releasedAt,
    ).not.toBeNull();
  });

  it('a cut-off send the delivery system has not seen, or cannot answer for, is sent again; a first attempt never asks', async () => {
    for (const answer of [false, null, 'throws'] as const) {
      const s = await setup();
      await db.outboundEmail.update({
        where: { id: s.reply.outboundId },
        data: { state: 'sending', leaseUntil: at(T0, 20_000), attempts: 1 },
      });
      const log: string[] = [];
      const lookup = async (): Promise<boolean | null> => {
        if (answer === 'throws') throw new Error('lookup down');
        return answer;
      };
      await runOutboundJob(db, {
        jobId: s.job,
        outboundId: s.reply.outboundId,
        now: at(T0, 40_000),
        leaseMs: 30_000,
        maxAttempts: 8,
        defaultFrom: 'support@helpdesk.test',
        send: send(log),
        policy,
        lookup,
      });
      expect(log, String(answer)).toHaveLength(1);
    }
    const fresh = await setup();
    let asked = 0;
    await runOutboundJob(db, {
      jobId: fresh.job,
      outboundId: fresh.reply.outboundId,
      now: at(T0, 10_000),
      leaseMs: 30_000,
      maxAttempts: 8,
      defaultFrom: 'support@helpdesk.test',
      send: send([]),
      policy,
      lookup: async () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(0);
  });

  it('a reply whose first send got a temporary error cannot be undone while it waits for the retry', async () => {
    const s = await setup();
    const log: string[] = [];
    const now = at(T0, 10_000);
    expect(await go(s, now, send(log, ['transient']))).toBe('retry');
    const waiting = await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } });
    expect(waiting.state).toBe('scheduled');
    expect(waiting.sendAfter.getTime()).toBeGreaterThan(now.getTime()); // the retry is in the future
    const undo = await run(db, at(now, 100), (c) =>
      cancelReply(c, {
        ticketId: s.t.ticketId,
        messageId: s.reply.messageId,
        actor: { kind: 'agent', userId: s.agent.id },
      }),
    );
    expect(undo.ok ? 'ok' : undo.error.code).toBe('UNDO_WINDOW_EXPIRED');
    expect(await go(s, waiting.sendAfter, send(log))).toBe('done');
    expect(log).toHaveLength(1); // still delivered once
  });

  it('five workers racing for the same email send it once', async () => {
    const s = await setup();
    const log: string[] = [];
    const slow: SendFn = async (m) => {
      await new Promise((r) => setTimeout(r, 40));
      return send(log)(m);
    };
    await burst(5, () => go(s, at(T0, 20_000), slow));
    expect(log).toHaveLength(1);
  });

  it('temporary SMTP errors (451) are retried with backoff and the customer still receives it exactly once', async () => {
    const s = await setup();
    const log: string[] = [];
    const script: Array<'ok' | 'transient' | 'permanent'> = ['transient', 'transient'];
    const fn = send(log, script);
    let now = at(T0, 10_000);
    expect(await go(s, now, fn)).toBe('retry');
    const first = await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } });
    expect([first.state, first.sendAfter.getTime() - now.getTime(), first.lastError]).toEqual([
      'scheduled',
      1000,
      '451 4.3.0 try later',
    ]);
    expect(await go(s, at(now, 500), fn)).toBe('skipped');
    now = first.sendAfter;
    expect(await go(s, now, fn)).toBe('retry');
    now = (await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } }))
      .sendAfter;
    expect(await go(s, now, fn)).toBe('done');
    expect(log).toHaveLength(1);
    expect(log[0]).toBe(
      (await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } }))
        .rfcMessageId,
    ); // same Message-ID on every attempt
  });

  it('a permanent failure marks the email failed and the job dead for the administrator', async () => {
    const s = await setup();
    const log: string[] = [];
    expect(await go(s, at(T0, 10_000), send(log, ['permanent']))).toBe('dead');
    expect(
      await db.outboundEmail.findUniqueOrThrow({ where: { id: s.reply.outboundId } }),
    ).toMatchObject({ state: 'failed', lastError: '550 mailbox unavailable' });
    expect(await db.job.findUniqueOrThrow({ where: { id: s.job } })).toMatchObject({
      status: 'dead',
    });
    expect((await eventsOf(db, s.t.ticketId)).map((e) => e.type)).toContain('email_failed');
    expect(log).toHaveLength(0);
  });

  it('a cancelled reply is never sent, even if the sender runs right after the cancel', async () => {
    const s = await setup();
    const log: string[] = [];
    await run(db, at(T0, 9_900), (c) =>
      cancelReply(c, {
        ticketId: s.t.ticketId,
        messageId: s.reply.messageId,
        actor: { kind: 'agent', userId: s.agent.id },
      }),
    );
    expect(await go(s, at(T0, 10_000), send(log))).toBe('done');
    expect(await go(s, at(T0, 60_000), send(log))).toBe('done');
    expect(log).toHaveLength(0);
  });

  it('a worker that died while sending is replaced after the lease expires; a live lease blocks others', async () => {
    const s = await setup();
    const log: string[] = [];
    const now = at(T0, 10_000);
    const dies: SendFn = () => Promise.reject(new Error('worker killed'));
    await expect(go(s, now, dies)).resolves.toBe('retry'); // an exception counts as a transient error
    await db.outboundEmail.update({
      where: { id: s.reply.outboundId },
      data: { state: 'sending', leaseUntil: at(now, 30_000) },
    });
    expect(await go(s, at(now, 10_000), send(log))).toBe('skipped');
    expect(await go(s, at(now, 31_000), send(log))).toBe('done');
    expect(log).toHaveLength(1);
  });
});

describe('INV-9 building blocks: pending work is always re-derivable from Postgres', () => {
  it('dueJobs lists pending jobs inside the horizon in time order; dead and done ones are ignored', async () => {
    const tag = uniq('h');
    for (const [i, off] of [5000, 1000, 3_000_000].entries())
      await upsertJob(db, {
        kind: 'assign_team',
        ref: tag,
        dedupeKey: `${tag}:${i}`,
        runAt: at(T0, off),
        now: T0,
      });
    await upsertJob(db, {
      kind: 'assign_team',
      ref: tag,
      dedupeKey: `${tag}:done`,
      runAt: at(T0, 10),
      now: T0,
    });
    await db.job.update({ where: { dedupeKey: `${tag}:done` }, data: { status: 'done' } });
    const due = (await dueJobs(db, T0, 60_000, 100_000)).filter(
      (j) => j.runAt <= at(T0, 6000) && j.runAt >= at(T0, 1000),
    );
    expect(due.map((d) => d.runAt.getTime())).toContain(at(T0, 1000).getTime());
    const mine = await dueJobs(db, T0, 60_000, 100_000);
    expect(mine.some((d) => d.runAt.getTime() === at(T0, 3_000_000).getTime())).toBe(false);
  });

  it('ensureDurableJobs recreates the assignment job for queued tickets with free agents, and sends for unsent mail', async () => {
    const team = await createTeam(db);
    await createAgent(db, team.id);
    const t = await newTicket(db, team.id, { ack: true });
    await db.job.deleteMany({
      where: {
        OR: [
          { dedupeKey: `assign:${team.id}` },
          {
            ref: {
              in: (await db.outboundEmail.findMany({ where: { ticketId: t.ticketId } })).map(
                (o) => o.id,
              ),
            },
          },
        ],
      },
    });
    const n = await ensureDurableJobs(db, at(T0, 1000));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(
      await db.job.count({ where: { dedupeKey: `assign:${team.id}`, status: 'pending' } }),
    ).toBe(1);
    const ack = await db.outboundEmail.findFirstOrThrow({ where: { ticketId: t.ticketId } });
    expect(
      await db.job.count({ where: { dedupeKey: `outbound:${ack.id}`, status: 'pending' } }),
    ).toBe(1);
    // Idempotent for this team's work: another run adds no second job (other test files may create unrelated rows meanwhile).
    await ensureDurableJobs(db, at(T0, 2000));
    await ensureDurableJobs(db, at(T0, 2000));
    expect(await db.job.count({ where: { dedupeKey: `assign:${team.id}` } })).toBe(1);
    expect(await db.job.count({ where: { dedupeKey: `outbound:${ack.id}` } })).toBe(1);
  });
});

describe('auto-close and survey (requirement: resolved -> closed after 3 days)', () => {
  it('closes a resolved ticket after 72 h without a customer reply and creates one survey; earlier it does nothing', async () => {
    const team = await createTeam(db);
    const agent = await createAgent(db, team.id);
    const t = await newTicket(db, team.id);
    await db.ticket.update({ where: { id: t.ticketId }, data: { assigneeId: agent.id } });
    await run(db, T0, (c) =>
      changeStatus(c, {
        ticketId: t.ticketId,
        actor: { kind: 'agent', userId: agent.id },
        to: 'resolved',
      }),
    );
    const id = await jobId(`auto_close:${t.ticketId}`);
    expect(
      await runTxJob(db, id, at(T0, 72 * H - 1), CFG, txHandlers.auto_close as TxHandler, policy),
    ).toBe('skipped');
    const outcomes = await burst(3, () =>
      runTxJob(db, id, at(T0, 72 * H), CFG, txHandlers.auto_close as TxHandler, policy),
    );
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
    expect(await ticketOf(db, t.ticketId)).toMatchObject({
      status: 'closed',
      closedAt: at(T0, 72 * H),
    });
    expect(await db.survey.count({ where: { ticketId: t.ticketId } })).toBe(1);
    expect(
      await db.outboundEmail.count({ where: { ticketId: t.ticketId, purpose: 'survey' } }),
    ).toBe(1);
  });
});

describe('dead jobs stay dead until someone re-arms them (review F3)', () => {
  it('the reconciler does not revive a dead assignment job, a user action does', async () => {
    const team = await createTeam(db);
    await createAgent(db, team.id);
    await newTicket(db, team.id);
    await db.job.updateMany({
      where: { dedupeKey: `assign:${team.id}` },
      data: { status: 'dead', lastError: 'boom' },
    });
    await ensureDurableJobs(db, at(T0, 1000));
    await ensureDurableJobs(db, at(T0, 2000));
    expect(
      (await db.job.findUniqueOrThrow({ where: { dedupeKey: `assign:${team.id}` } })).status,
    ).toBe('dead');
    await requestTeamAssignment(db, team.id, at(T0, 3000));
    expect(
      (await db.job.findUniqueOrThrow({ where: { dedupeKey: `assign:${team.id}` } })).status,
    ).toBe('pending');
  });
});

describe('missing SLA timer rows are rebuilt from the ticket (review F21)', () => {
  it('a ticket with deadlines but no timers gets its warning and breach rows back, once', async () => {
    const team = await createTeam(db);
    const t = await newTicket(db, team.id);
    await db.job.deleteMany({
      where: { ref: t.ticketId, kind: { in: ['sla_warning', 'sla_breach'] } },
    });
    expect(
      await db.job.count({
        where: { ref: t.ticketId, kind: { in: ['sla_warning', 'sla_breach'] } },
      }),
    ).toBe(0);
    await ensureDurableJobs(db, at(T0, 1000), { slaTimers: { warningRatio: 0.8 } });
    const rows = await db.job.findMany({
      where: { ref: t.ticketId, kind: { in: ['sla_warning', 'sla_breach'] } },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    await ensureDurableJobs(db, at(T0, 2000), { slaTimers: { warningRatio: 0.8 } });
    expect(
      await db.job.count({
        where: { ref: t.ticketId, kind: { in: ['sla_warning', 'sla_breach'] } },
      }),
    ).toBe(rows.length);
  });
});
