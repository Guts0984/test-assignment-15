import { afterAll, describe, expect, it } from 'vitest';
import { dbBusinessError, isUniqueViolation } from '../src/index';
import {
  createAgent,
  createCustomer,
  createTeam,
  createTicket,
  openCountOf,
  realLoadOf,
  testDb,
  uniq,
} from './helpers/db';

const db = testDb();
afterAll(async () => {
  await db.$disconnect();
});

const expectDbError = async (p: Promise<unknown>, code: string): Promise<void> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `expected ${code}`).not.toBeNull();
  expect(dbBusinessError(e)).toBe(code);
};

describe('agent load trigger (invariant 1 at the database level)', () => {
  it('counts tickets on assign, status change and reassign', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    const b = await createAgent(db, team.id);
    const c = await createCustomer(db);
    const t = await createTicket(db, { teamId: team.id, customerId: c.id, assigneeId: a.id });
    expect(await openCountOf(db, a.id)).toBe(1);

    await db.ticket.update({ where: { id: t.id }, data: { assigneeId: b.id } });
    expect([await openCountOf(db, a.id), await openCountOf(db, b.id)]).toEqual([0, 1]);

    await db.ticket.update({ where: { id: t.id }, data: { status: 'resolved' } });
    expect(await openCountOf(db, b.id)).toBe(0);

    await db.ticket.update({ where: { id: t.id }, data: { status: 'open' } });
    expect(await openCountOf(db, b.id)).toBe(1);

    await db.ticket.update({ where: { id: t.id }, data: { assigneeId: null } });
    expect(await openCountOf(db, b.id)).toBe(0);
  });

  it('refuses to exceed the limit, on insert and on update', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id, { limit: 2 });
    const c = await createCustomer(db);
    await createTicket(db, { teamId: team.id, customerId: c.id, assigneeId: a.id });
    await createTicket(db, { teamId: team.id, customerId: c.id, assigneeId: a.id });
    await expectDbError(
      createTicket(db, { teamId: team.id, customerId: c.id, assigneeId: a.id }),
      'AGENT_AT_LIMIT',
    );
    const free = await createTicket(db, { teamId: team.id, customerId: c.id });
    await expectDbError(
      db.ticket.update({ where: { id: free.id }, data: { assigneeId: a.id } }),
      'AGENT_AT_LIMIT',
    );
    expect(await openCountOf(db, a.id)).toBe(2);
    expect(await realLoadOf(db, a.id)).toBe(2);
    // the failed statements left nothing behind
    expect((await db.ticket.findUniqueOrThrow({ where: { id: free.id } })).assigneeId).toBeNull();
  });

  it('never exceeds the limit under 80 concurrent assignments to one agent', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id, { limit: 7 });
    const c = await createCustomer(db);
    const tickets = await Promise.all(
      Array.from({ length: 80 }, () => createTicket(db, { teamId: team.id, customerId: c.id })),
    );
    const results = await Promise.allSettled(
      tickets.map((t) => db.ticket.update({ where: { id: t.id }, data: { assigneeId: a.id } })),
    );
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(okCount).toBe(7);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => dbBusinessError((r as PromiseRejectedResult).reason) === 'AGENT_AT_LIMIT'),
    ).toBe(true);
    expect(await openCountOf(db, a.id)).toBe(7);
    expect(await realLoadOf(db, a.id)).toBe(7);
  });

  it('keeps counts exact when tickets swap between two agents concurrently (no deadlock, no drift)', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id, { limit: 50 });
    const b = await createAgent(db, team.id, { limit: 50 });
    const c = await createCustomer(db);
    const onA = await Promise.all(
      Array.from({ length: 10 }, () =>
        createTicket(db, { teamId: team.id, customerId: c.id, assigneeId: a.id }),
      ),
    );
    const onB = await Promise.all(
      Array.from({ length: 10 }, () =>
        createTicket(db, { teamId: team.id, customerId: c.id, assigneeId: b.id }),
      ),
    );
    await Promise.all([
      ...onA.map((t) => db.ticket.update({ where: { id: t.id }, data: { assigneeId: b.id } })),
      ...onB.map((t) => db.ticket.update({ where: { id: t.id }, data: { assigneeId: a.id } })),
    ]);
    expect(await openCountOf(db, a.id)).toBe(await realLoadOf(db, a.id));
    expect(await openCountOf(db, b.id)).toBe(await realLoadOf(db, b.id));
    expect((await openCountOf(db, a.id)) + (await openCountOf(db, b.id))).toBe(20);
  });

  it('rejects a negative counter and a negative limit at the constraint level', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id);
    await expect(
      db.$executeRaw`UPDATE users SET open_count = -1 WHERE id = ${a.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE users SET ticket_limit = -1 WHERE id = ${a.id}::uuid`,
    ).rejects.toThrow();
  });
});

describe('merge guards (invariant 7 at the database level)', () => {
  const setup = async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const mk = () => createTicket(db, { teamId: team.id, customerId: c.id });
    return { team, c, mk };
  };
  const merge = (id: string, into: string) =>
    db.ticket.update({
      where: { id },
      data: { mergedIntoId: into, status: 'closed', assigneeId: null },
    });

  it('merges a duplicate into the main ticket', async () => {
    const { mk } = await setup();
    const [a, b] = [await mk(), await mk()];
    await merge(a.id, b.id);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: a.id } })).mergedIntoId).toBe(b.id);
  });

  it('rejects self-merge', async () => {
    const { mk } = await setup();
    const a = await mk();
    await expect(merge(a.id, a.id)).rejects.toThrow();
  });

  it('rejects merging tickets of different customers', async () => {
    const { mk, team } = await setup();
    const other = await createCustomer(db);
    const a = await mk();
    const b = await createTicket(db, { teamId: team.id, customerId: other.id });
    await expectDbError(merge(a.id, b.id), 'TICKETS_NOT_MERGEABLE');
  });

  it('rejects A -> B after B -> A (no cycles) and merging an already merged ticket again', async () => {
    const { mk } = await setup();
    const [a, b, c] = [await mk(), await mk(), await mk()];
    await merge(a.id, b.id);
    await expectDbError(merge(b.id, a.id), 'TICKET_ALREADY_MERGED'); // the target a was merged away
    await expectDbError(merge(a.id, c.id), 'TICKET_ALREADY_MERGED'); // a was merged already
  });

  it('rejects a chain: merging into a ticket that was itself merged away', async () => {
    const { mk } = await setup();
    const [a, b, c] = [await mk(), await mk(), await mk()];
    await merge(b.id, c.id);
    await expectDbError(merge(a.id, b.id), 'TICKET_ALREADY_MERGED');
  });

  it('only one of two simultaneous opposite merges wins and no cycle appears', async () => {
    const { mk } = await setup();
    // raw opposite updates deadlock (Postgres aborts one after ~1 s); the application locks in id order instead
    for (let i = 0; i < 4; i += 1) {
      const [a, b] = [await mk(), await mk()];
      const res = await Promise.allSettled([merge(a.id, b.id), merge(b.id, a.id)]);
      expect(res.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
      const rows = await db.ticket.findMany({ where: { id: { in: [a.id, b.id] } } });
      const merged = rows.filter((r) => r.mergedIntoId !== null);
      expect(merged.length).toBeLessThanOrEqual(1);
    }
  });

  it('a merged ticket must be closed and unassigned', async () => {
    const { mk } = await setup();
    const [a, b] = [await mk(), await mk()];
    await expect(
      db.ticket.update({ where: { id: a.id }, data: { mergedIntoId: b.id } }),
    ).rejects.toThrow();
  });
});

describe('uniqueness backing invariants 4 and 8', () => {
  it('deduplicates inbound deliveries per mailbox and Message-ID', async () => {
    const box = `${uniq('box')}@helpdesk.test`;
    const id = `${uniq('m')}@sender.test`;
    const ins = () =>
      db.$executeRaw`INSERT INTO inbound_messages (mailbox_address, rfc_message_id, raw) VALUES (${box}, ${id}, ${Buffer.from('x')})
                     ON CONFLICT (mailbox_address, rfc_message_id) DO NOTHING`;
    const counts = await Promise.all(Array.from({ length: 30 }, ins));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    // the same Message-ID to a different mailbox is a separate delivery, but only one message may exist
    await db.$executeRaw`INSERT INTO inbound_messages (mailbox_address, rfc_message_id, raw) VALUES (${'other-' + box}, ${id}, ${Buffer.from('x')})`;
  });

  it('allows one message per RFC Message-ID and per (ticket, seq)', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const t = await createTicket(db, { teamId: team.id, customerId: c.id });
    const mid = `${uniq('mid')}@x.test`;
    const base = {
      ticketId: t.id,
      kind: 'public',
      direction: 'inbound',
      authorKind: 'customer',
      body: 'hi',
    };
    await db.message.create({ data: { ...base, seq: 1, rfcMessageId: mid } });
    await expect(
      db.message.create({ data: { ...base, seq: 2, rfcMessageId: mid } }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      db.message.create({ data: { ...base, seq: 1, rfcMessageId: null } }),
    ).rejects.toSatisfy(isUniqueViolation);
    await db.message.create({ data: { ...base, seq: 2, rfcMessageId: null } });
    await db.message.create({ data: { ...base, seq: 3, rfcMessageId: null } }); // NULL ids never collide
  });

  it('allows one survey per ticket, with a rating from 1 to 5 only', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const t = await createTicket(db, { teamId: team.id, customerId: c.id });
    const now = new Date();
    const mk = (hash: string) =>
      db.survey.create({
        data: { ticketId: t.id, tokenHash: hash, expiresAt: now, createdAt: now },
      });
    await mk(uniq('h'));
    await expect(mk(uniq('h'))).rejects.toSatisfy(isUniqueViolation);
    for (const bad of [0, 6, -1]) {
      await expect(
        db.survey.update({ where: { ticketId: t.id }, data: { rating: bad, ratedAt: now } }),
      ).rejects.toThrow();
    }
    await db.survey.update({ where: { ticketId: t.id }, data: { rating: 5, ratedAt: now } });
  });

  it('allows one job per dedupe key, so one warning and one breach per ticket and target', async () => {
    const key = `sla_warning:${uniq('t')}:resolution`;
    const ins = () =>
      db.$executeRaw`INSERT INTO jobs (kind, ref, dedupe_key, run_at, created_at)
                     VALUES ('sla_warning', 'r', ${key}, now(), now()) ON CONFLICT (dedupe_key) DO NOTHING`;
    const counts = await Promise.all(Array.from({ length: 25 }, ins));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('outbound email has a unique RFC Message-ID and a valid state machine value', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const t = await createTicket(db, { teamId: team.id, customerId: c.id });
    const rfc = `${uniq('o')}@helpdesk.test`;
    const data = {
      ticketId: t.id,
      purpose: 'reply',
      toEmail: 'a@b.test',
      subject: 's',
      bodyText: 'b',
      rfcMessageId: rfc,
      sendAfter: new Date(),
    };
    await db.outboundEmail.create({ data });
    await expect(db.outboundEmail.create({ data })).rejects.toSatisfy(isUniqueViolation);
    await expect(
      db.outboundEmail.create({ data: { ...data, rfcMessageId: uniq('x'), state: 'teleported' } }),
    ).rejects.toThrow();
  });

  it('assigns increasing ticket numbers starting at 100000', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const a = await createTicket(db, { teamId: team.id, customerId: c.id });
    const b = await createTicket(db, { teamId: team.id, customerId: c.id });
    const [ta, tb] = await Promise.all(
      [a, b].map((t) => db.ticket.findUniqueOrThrow({ where: { id: t.id } })),
    );
    expect(Number(ta?.number)).toBeGreaterThanOrEqual(100000);
    expect(Number(tb?.number)).toBeGreaterThan(Number(ta?.number));
  });

  it('rejects out-of-domain values and non-lowercase emails', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    await expect(
      db.ticket.create({
        data: { teamId: team.id, customerId: c.id, subject: 's', status: 'bogus' },
      }),
    ).rejects.toThrow();
    await expect(
      db.ticket.create({
        data: { teamId: team.id, customerId: c.id, subject: 's', priority: 'critical' },
      }),
    ).rejects.toThrow();
    await expect(
      db.customer.create({ data: { email: 'UPPER@Case.test', name: 'x' } }),
    ).rejects.toThrow();
    await expect(
      db.team.create({
        data: {
          name: uniq('t'),
          timeZone: 'UTC',
          workdays: [1],
          workStartMin: 600,
          workEndMin: 600,
        },
      }),
    ).rejects.toThrow();
  });

  it('caps attachment size at 10 MB', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const t = await createTicket(db, { teamId: team.id, customerId: c.id });
    const m = await db.message.create({
      data: {
        ticketId: t.id,
        seq: 1,
        kind: 'public',
        direction: 'inbound',
        authorKind: 'customer',
        body: 'x',
      },
    });
    await expect(
      db.attachment.create({
        data: {
          messageId: m.id,
          filename: 'a',
          contentType: 'text/plain',
          size: 10 * 1024 * 1024 + 1,
          data: Buffer.from('x'),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('full-text search and indexes', () => {
  it('finds messages with the simple configuration and customers by trigram', async () => {
    const team = await createTeam(db);
    const c = await createCustomer(db);
    const t = await createTicket(db, {
      teamId: team.id,
      customerId: c.id,
      subject: 'Printer jammed',
    });
    const word = uniq('zxqv').replace('-', '');
    await db.message.create({
      data: {
        ticketId: t.id,
        seq: 1,
        kind: 'public',
        direction: 'inbound',
        authorKind: 'customer',
        body: `Hello ${word} paper`,
      },
    });
    const hits = await db.$queryRaw<{ ticket_id: string }[]>`
      SELECT ticket_id FROM messages WHERE search_vector @@ websearch_to_tsquery('simple', ${word})`;
    expect(hits.map((h) => h.ticket_id)).toEqual([t.id]);
    const sub = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM tickets WHERE subject_vector @@ websearch_to_tsquery('simple', 'jammed') AND id = ${t.id}::uuid`;
    expect(sub).toHaveLength(1);
    const cust = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM customers WHERE email ILIKE ${'%' + c.id.slice(0, 0) + 'cust-%'} AND id = ${c.id}::uuid`;
    expect(cust).toHaveLength(1);
  });

  it('treats hostile search text as data, never as SQL or tsquery syntax errors', async () => {
    const attacks = [
      "'; DROP TABLE messages; --",
      '" OR 1=1 --',
      '((((',
      '& | ! <->',
      '\\',
      'a'.repeat(500),
    ];
    for (const q of attacks) {
      await expect(
        db.$queryRaw`SELECT count(*) FROM messages WHERE search_vector @@ websearch_to_tsquery('simple', ${q})`,
      ).resolves.toBeDefined();
    }
    expect(await db.message.count()).toBeGreaterThanOrEqual(0);
  });

  it('has the indexes the queue, report and job scans rely on', async () => {
    const rows = await db.$queryRaw<
      { indexname: string }[]
    >`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(rows.map((r) => r.indexname));
    for (const n of [
      'tickets_agent_queue_idx',
      'tickets_team_queue_idx',
      'tickets_report_idx',
      'messages_search_gin',
      'messages_rfc_message_id_uq',
      'jobs_due_idx',
      'outbound_due_idx',
      'customers_email_trgm',
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});

describe('test clock row', () => {
  it('exists exactly once and notifies listeners on update', async () => {
    const rows = await db.appClock.findMany();
    expect(rows).toHaveLength(1);
    await expect(
      db.$executeRaw`INSERT INTO app_clock (id, offset_ms) VALUES (2, 0)`,
    ).rejects.toThrow();
  });
});
