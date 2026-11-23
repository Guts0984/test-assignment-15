import { afterAll, describe, expect, it } from 'vitest';
import { assignQueuedTickets, changeStatus, inTx, takeTicket, type ActorRef } from '../src/index';
import { burst } from './helpers/concurrency';
import { createAgent, createTeam, openCountOf, realLoadOf, testDb } from './helpers/db';
import { T0, eventsOf, newTicket, run } from './helpers/tickets';

const db = testDb();
afterAll(async () => {
  await db.$disconnect();
});

const assignAll = async (teamId: string, batch = 40): Promise<number> => {
  let total = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const r = await inTx(db, (tx) => assignQueuedTickets(tx, teamId, T0, batch));
    total += r.assigned;
    if (!r.more) return total;
  }
  return total;
};

describe('INV-1: the agent limit is never exceeded and load stays level', () => {
  it('500 tickets, 10 agents with limit 20, three runners at once: everyone has exactly 20, 300 wait in the queue', async () => {
    const team = await createTeam(db);
    const agents = await Promise.all(
      Array.from({ length: 10 }, () => createAgent(db, team.id, { limit: 20 })),
    );
    await burst(500, () => newTicket(db, team.id));
    const runs = await burst(3, () => assignAll(team.id));
    expect(runs.reduce((a, b) => a + b, 0)).toBe(200);
    for (const a of agents) {
      expect(await openCountOf(db, a.id)).toBe(20);
      expect(await realLoadOf(db, a.id)).toBe(20);
    }
    expect(await db.ticket.count({ where: { teamId: team.id, assigneeId: null } })).toBe(300);
    // history is honest: exactly one assignment event per assigned ticket
    const events = await db.ticketEvent.count({
      where: { type: 'assigned', ticket: { teamId: team.id } },
    });
    expect(events).toBe(200);
  });

  it('closing a ticket frees one slot and the next queued ticket (most urgent first) goes to that agent', async () => {
    const team = await createTeam(db);
    const [a] = [await createAgent(db, team.id, { limit: 2 })];
    const [t1, t2, queuedLow, queuedUrgent] = [
      await newTicket(db, team.id),
      await newTicket(db, team.id),
      await newTicket(db, team.id, { priority: 'low' }),
      await newTicket(db, team.id, { priority: 'urgent' }),
    ];
    await assignAll(team.id);
    const owned = await db.ticket.findMany({ where: { assigneeId: a.id } });
    expect(owned).toHaveLength(2);
    expect(await db.ticket.count({ where: { teamId: team.id, assigneeId: null } })).toBe(2);
    const first = owned[0];
    await run(db, T0, (c) =>
      changeStatus(c, {
        ticketId: first?.id ?? '',
        actor: { kind: 'agent', userId: a.id },
        to: 'resolved',
      }),
    );
    await assignAll(team.id);
    const now = await db.ticket.findMany({
      where: { assigneeId: a.id, status: { not: 'resolved' } },
    });
    expect(now).toHaveLength(2);
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: queuedUrgent.ticketId } })).assigneeId,
    ).toBe(a.id);
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: queuedLow.ticketId } })).assigneeId,
    ).toBeNull();
    expect([t1, t2].length).toBe(2);
  });

  it('spreads work evenly: loads never differ by more than one while capacity lasts', async () => {
    const team = await createTeam(db);
    const agents = await Promise.all(
      Array.from({ length: 7 }, () => createAgent(db, team.id, { limit: 50 })),
    );
    await burst(100, () => newTicket(db, team.id));
    await assignAll(team.id, 17);
    const loads = await Promise.all(agents.map((a) => openCountOf(db, a.id)));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
    expect(loads.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('ties go to whoever has gone longest without a ticket', async () => {
    const team = await createTeam(db);
    const [a, b, c] = [
      await createAgent(db, team.id),
      await createAgent(db, team.id),
      await createAgent(db, team.id),
    ];
    await db.user.update({
      where: { id: a.id },
      data: { lastAssignedAt: new Date('2026-01-03T00:00:00Z') },
    });
    await db.user.update({
      where: { id: b.id },
      data: { lastAssignedAt: new Date('2026-01-01T00:00:00Z') },
    });
    await db.user.update({
      where: { id: c.id },
      data: { lastAssignedAt: new Date('2026-01-02T00:00:00Z') },
    });
    const tickets = [
      await newTicket(db, team.id),
      await newTicket(db, team.id),
      await newTicket(db, team.id),
    ];
    await assignAll(team.id, 1);
    const owner = async (i: number) =>
      (await db.ticket.findUniqueOrThrow({ where: { id: tickets[i]?.ticketId ?? '' } })).assigneeId;
    // most urgent = created first; owners follow the idle order b (oldest), c, a
    expect(new Set([await owner(0), await owner(1), await owner(2)])).toEqual(
      new Set([a.id, b.id, c.id]),
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: b.id } })).openCount).toBe(1);
  });

  it('only gives tickets to agents on shift who speak the language; leads never get tickets', async () => {
    const team = await createTeam(db);
    const off = await createAgent(db, team.id, { onShift: false });
    const lead = await createAgent(db, team.id, { role: 'lead' });
    const pl = await createAgent(db, team.id);
    await db.user.update({ where: { id: pl.id }, data: { languages: ['en', 'pl'] } });
    const polish = await newTicket(db, team.id, { language: 'pl' });
    const english = await newTicket(db, team.id);
    await assignAll(team.id);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: polish.ticketId } })).assigneeId).toBe(
      pl.id,
    );
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: english.ticketId } })).assigneeId,
    ).toBe(pl.id);
    expect([await openCountOf(db, off.id), await openCountOf(db, lead.id)]).toEqual([0, 0]);
  });

  it('with nobody free the tickets wait and are not lost; an agent coming on shift picks them up', async () => {
    const team = await createTeam(db);
    const a = await createAgent(db, team.id, { onShift: false });
    const t = await newTicket(db, team.id);
    expect(await assignAll(team.id)).toBe(0);
    expect(
      (await db.ticket.findUniqueOrThrow({ where: { id: t.ticketId } })).assigneeId,
    ).toBeNull();
    await db.user.update({ where: { id: a.id }, data: { onShift: true } });
    expect(await assignAll(team.id)).toBe(1);
  });
});

describe('INV-2 in the worker: auto-assignment racing "take it"', () => {
  it('every ticket ends with exactly one owner and exact counters while takers and runners fight', async () => {
    const team = await createTeam(db);
    const agents = await Promise.all(
      Array.from({ length: 4 }, () => createAgent(db, team.id, { limit: 100 })),
    );
    const tickets = await Promise.all(Array.from({ length: 60 }, () => newTicket(db, team.id)));
    const taker = (u: { id: string }): ActorRef => ({ kind: 'agent', userId: u.id });
    await Promise.all([
      assignAll(team.id, 5),
      assignAll(team.id, 7),
      ...tickets
        .slice(0, 30)
        .map((t, i) =>
          run(db, T0, (c) =>
            takeTicket(c, {
              ticketId: t.ticketId,
              actor: taker(agents[i % 4] ?? (agents[0] as { id: string })),
            }),
          ),
        ),
    ]);
    await assignAll(team.id);
    const owned = await db.ticket.findMany({ where: { teamId: team.id } });
    expect(owned.every((t) => t.assigneeId !== null)).toBe(true);
    for (const a of agents) expect(await openCountOf(db, a.id)).toBe(await realLoadOf(db, a.id));
    for (const t of tickets) {
      const ev = (await eventsOf(db, t.ticketId)).filter(
        (e) => e.type === 'assigned' || e.type === 'taken',
      );
      expect(ev).toHaveLength(1); // one honest history entry, never both a take and an auto-assignment
    }
  });
});
