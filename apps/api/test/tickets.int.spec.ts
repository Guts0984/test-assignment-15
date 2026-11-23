import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTeamRow,
  createUserRow,
  login,
  startApi,
  testDb,
  uniq,
  type LoggedIn,
  type RunningApi,
} from './helpers/api';
import { createMailbox, receiveTicket } from './helpers/tickets';

let api: RunningApi;
const db = testDb();
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

const T = '/api/v1/tickets';
const world = async () => {
  const team = await createTeamRow(db);
  const box = await createMailbox(team.id);
  const agent = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] }),
  );
  const colleague = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] }),
  );
  const lead = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'lead' }] }),
  );
  const t = await receiveTicket(api, box);
  return { team, box, agent, colleague, lead, ...t };
};
const take = async (w: Awaited<ReturnType<typeof world>>, who: LoggedIn = w.agent) =>
  (await who.client.post(`${T}/${w.ticketId}/take`, {})).status;

describe('agent queue and detail', () => {
  it('lists the agent own tickets by SLA deadline and the team queue separately', async () => {
    const w = await world();
    const second = await receiveTicket(api, w.box, { subject: 'Second' });
    expect(await take(w)).toBe(200);
    await w.agent.client.post(`${T}/${second.ticketId}/take`, {});
    await db.ticket.update({ where: { id: second.ticketId }, data: { priority: 'urgent' } });
    await db.$executeRaw`UPDATE tickets SET next_due_at = now() + interval '1 hour' WHERE id = ${second.ticketId}::uuid`;
    const q = (await w.agent.client.get(`${T}/queue`)).json as {
      items: { id: string; nextDueAt: string }[];
      serverTime: string;
    };
    expect(q.items.map((i) => i.id)).toEqual(
      [second.ticketId, w.ticketId].sort((a) => (a === second.ticketId ? -1 : 1)),
    );
    expect(Date.parse(q.serverTime)).toBeGreaterThan(0);
    const unassigned = (await w.colleague.client.get(`${T}/unassigned`)).json as {
      items: { id: string }[];
    };
    expect(unassigned.items.map((i) => i.id)).not.toContain(w.ticketId);
  });

  it('shows the whole correspondence, internal notes and history to staff of the team', async () => {
    const w = await world();
    await take(w);
    await w.agent.client.post(`${T}/${w.ticketId}/notes`, { body: 'internal thought' });
    const d = (await w.agent.client.get(`${T}/${w.ticketId}`)).json as {
      ticket: { number: number; messageSeq: number };
      messages: { kind: string; body: string }[];
      events: { type: string }[];
    };
    expect(d.ticket.number).toBe(w.number);
    expect(d.messages.map((m) => m.kind)).toEqual(['public', 'note']);
    expect(d.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['created', 'taken', 'note']),
    );
  });
});

describe('reply, undo and the concurrent-reply warning over HTTP', () => {
  it('replies, then undoes within the window; the second undo is refused', async () => {
    const w = await world();
    await take(w);
    const r = await w.agent.client.post(`${T}/${w.ticketId}/replies`, {
      body: 'We are on it',
      lastSeenSeq: 1,
    });
    expect(r.status).toBe(201);
    const { messageId, sendAfter } = r.json as { messageId: string; sendAfter: string };
    expect(Date.parse(sendAfter) - Date.now()).toBeGreaterThan(5000);
    expect((await w.agent.client.del(`${T}/${w.ticketId}/replies/${messageId}`)).status).toBe(200);
    expect((await w.agent.client.del(`${T}/${w.ticketId}/replies/${messageId}`)).status).toBe(409);
    expect((await db.outboundEmail.findFirstOrThrow({ where: { messageId } })).state).toBe(
      'cancelled',
    );
  });

  it('a colleague cannot undo someone else reply but a lead can', async () => {
    const w = await world();
    await take(w);
    const { messageId } = (
      await w.agent.client.post(`${T}/${w.ticketId}/replies`, { body: 'x', lastSeenSeq: 1 })
    ).json as { messageId: string };
    expect((await w.colleague.client.del(`${T}/${w.ticketId}/replies/${messageId}`)).status).toBe(
      403,
    );
    expect((await w.lead.client.del(`${T}/${w.ticketId}/replies/${messageId}`)).status).toBe(200);
  });

  it('two agents replying at once: one is accepted, the other gets 409 TICKET_HAS_NEW_MESSAGES with the new message and must confirm', async () => {
    const w = await world();
    const results = await Promise.all([
      w.agent.client.post(`${T}/${w.ticketId}/replies`, { body: 'A', lastSeenSeq: 1 }),
      w.colleague.client.post(`${T}/${w.ticketId}/replies`, { body: 'B', lastSeenSeq: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    const err = (
      loser?.json as {
        error: { code: string; data: { latestSeq: number; messages: { body: string }[] } };
      }
    ).error;
    expect(err.code).toBe('TICKET_HAS_NEW_MESSAGES');
    expect(err.data.messages).toHaveLength(1);
    expect(
      await db.outboundEmail.count({ where: { ticketId: w.ticketId, purpose: 'reply' } }),
    ).toBe(1);
    const who = results.findIndex((r) => r.status === 409) === 0 ? w.agent : w.colleague;
    const confirmed = await who.client.post(`${T}/${w.ticketId}/replies`, {
      body: 'sent anyway',
      lastSeenSeq: 1,
      confirmedSeq: err.data.latestSeq,
    });
    expect(confirmed.status).toBe(201);
  });

  it('validates reply bodies with field errors', async () => {
    const w = await world();
    const r = await w.agent.client.post(`${T}/${w.ticketId}/replies`, {
      body: '',
      lastSeenSeq: -2,
    });
    expect(r.status).toBe(400);
    expect(
      (r.json as { error: { details: { path: string[] }[] } }).error.details.map((d) => d.path[0]),
    ).toEqual(expect.arrayContaining(['body', 'lastSeenSeq']));
  });
});

describe('status, priority, team, transfer, take, merge', () => {
  it('applies the transition table per role: an agent cannot close, a lead can close a resolved ticket', async () => {
    const w = await world();
    await take(w);
    expect(
      (await w.agent.client.put(`${T}/${w.ticketId}/status`, { status: 'closed' })).status,
    ).toBe(409);
    expect(
      (await w.agent.client.put(`${T}/${w.ticketId}/status`, { status: 'resolved' })).status,
    ).toBe(200);
    expect(
      (await w.agent.client.put(`${T}/${w.ticketId}/status`, { status: 'closed' })).status,
    ).toBe(409);
    expect(
      (await w.lead.client.put(`${T}/${w.ticketId}/status`, { status: 'closed' })).status,
    ).toBe(200);
    expect(await db.survey.count({ where: { ticketId: w.ticketId } })).toBe(1);
  });

  it('changes priority and recomputes deadlines; moves to another team', async () => {
    const w = await world();
    const other = await createTeamRow(db, { timeZone: 'Europe/Warsaw' });
    const before = await db.ticket.findUniqueOrThrow({ where: { id: w.ticketId } });
    expect(
      (await w.agent.client.put(`${T}/${w.ticketId}/priority`, { priority: 'urgent' })).status,
    ).toBe(200);
    expect(
      (
        await db.ticket.findUniqueOrThrow({ where: { id: w.ticketId } })
      ).firstResponseDueAt?.getTime(),
    ).toBeLessThan(before.firstResponseDueAt?.getTime() ?? 0);
    expect((await w.agent.client.put(`${T}/${w.ticketId}/team`, { teamId: other.id })).status).toBe(
      200,
    );
    expect((await db.ticket.findUniqueOrThrow({ where: { id: w.ticketId } })).teamId).toBe(
      other.id,
    );
    // the agent lost access to the ticket along with the team
    expect((await w.agent.client.get(`${T}/${w.ticketId}`)).status).toBe(404);
  });

  it('transfer and take-it: one owner, AGENT_AT_LIMIT is reported, leads reassign', async () => {
    const w = await world();
    expect(await take(w)).toBe(200);
    expect(await take(w, w.colleague)).toBe(409);
    expect(
      (
        await w.colleague.client.post(`${T}/${w.ticketId}/transfer`, {
          assigneeId: w.colleague.user.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.agent.client.post(`${T}/${w.ticketId}/transfer`, {
          assigneeId: w.colleague.user.id,
        })
      ).status,
    ).toBe(200);
    await db.user.update({ where: { id: w.agent.user.id }, data: { ticketLimit: 0 } });
    const back = await w.lead.client.post(`${T}/${w.ticketId}/transfer`, {
      assigneeId: w.agent.user.id,
    });
    expect(back.status).toBe(409);
    expect((back.json as { error: { code: string } }).error.code).toBe('AGENT_AT_LIMIT');
    expect((await db.ticket.findUniqueOrThrow({ where: { id: w.ticketId } })).assigneeId).toBe(
      w.colleague.user.id,
    );
  });

  it('merges a duplicate of the same customer into the main ticket and refuses a foreign one', async () => {
    const w = await world();
    const dup = await receiveTicket(api, w.box, { from: w.from, subject: 'Same problem again' });
    const foreign = await receiveTicket(api, w.box);
    expect(
      (
        await w.agent.client.post(`${T}/${dup.ticketId}/merge`, {
          targetTicketId: foreign.ticketId,
        })
      ).status,
    ).toBe(409);
    expect(
      (await w.agent.client.post(`${T}/${dup.ticketId}/merge`, { targetTicketId: w.ticketId }))
        .status,
    ).toBe(200);
    const d = (await w.agent.client.get(`${T}/${dup.ticketId}`)).json as {
      ticket: { status: string; mergedIntoNumber: number };
    };
    expect([d.ticket.status, d.ticket.mergedIntoNumber]).toEqual(['closed', w.number]);
    expect(await db.message.count({ where: { ticketId: w.ticketId } })).toBe(2);
    expect(
      (await w.agent.client.post(`${T}/${dup.ticketId}/merge`, { targetTicketId: w.ticketId }))
        .status,
    ).toBe(409);
  });
});

describe('search, dashboard and reports', () => {
  it('finds tickets by correspondence text, customer and number, only within my teams', async () => {
    const w = await world();
    const word = `zq${uniq('w').replace('-', '')}`;
    const t = await receiveTicket(api, w.box, { text: `my ${word} is broken` });
    const other = await createTeamRow(db);
    const otherBox = await createMailbox(other.id);
    const hidden = await receiveTicket(api, otherBox, { text: `their ${word} too` });
    const byText = (await w.agent.client.get(`/api/v1/search?q=${word}`)).json as {
      items: { id: string }[];
    };
    expect(byText.items.map((i) => i.id)).toEqual([t.ticketId]);
    expect(byText.items.map((i) => i.id)).not.toContain(hidden.ticketId);
    const byNumber = (await w.agent.client.get(`/api/v1/search?q=%23${t.number}`)).json as {
      items: { id: string }[];
    };
    expect(byNumber.items.map((i) => i.id)).toEqual([t.ticketId]);
    const byEmail = (await w.agent.client.get(`/api/v1/search?q=${encodeURIComponent(t.from)}`))
      .json as { items: { id: string }[] };
    expect(byEmail.items.map((i) => i.id)).toContain(t.ticketId);
    // a customer name that appears in no message must still find the ticket (review F7)
    const uniqueName = `Zq${uniq('n').replace('-', '')} Surname`;
    await db.customer.update({ where: { email: t.from }, data: { name: uniqueName } });
    const byName = (
      await w.agent.client.get(
        `/api/v1/search?q=${encodeURIComponent(uniqueName.split(' ')[0] ?? '')}`,
      )
    ).json as { items: { id: string }[] };
    expect(byName.items.map((i) => i.id)).toEqual([t.ticketId]);
    for (const evil of ["'; DROP TABLE tickets;--", '"', '((', '&|!', '%', '\\']) {
      expect(
        (await w.agent.client.get(`/api/v1/search?q=${encodeURIComponent(evil)}`)).status,
      ).toBeLessThan(500);
    }
  });

  it('a very common word lists the newest matching tickets first, not a sample (review F7)', async () => {
    const w = await world();
    const word = `zq${uniq('c').replace('-', '')}`;
    const older = await receiveTicket(api, w.box, { text: `old ${word}` });
    // more matching messages than the candidate cap, all on the older ticket
    await db.$executeRaw`INSERT INTO messages (id, ticket_id, seq, kind, direction, author_kind, body, created_at)
      SELECT gen_random_uuid(), ${older.ticketId}::uuid, 100 + g, 'note', 'internal', 'agent', ${`filler ${word}`}, now()
        FROM generate_series(1, 2100) g`;
    const newest = await receiveTicket(api, w.box, { text: `new ${word}` });
    const found = (await w.agent.client.get(`/api/v1/search?q=${word}`)).json as {
      items: { id: string }[];
    };
    expect(found.items.map((i) => i.id)).toEqual([newest.ticketId, older.ticketId]);
  });

  it('lead dashboard: agent load, unassigned queue, at-risk and overdue; agents and other leads are refused', async () => {
    const w = await world();
    await db.ticket.update({
      where: { id: w.ticketId },
      data: {
        firstResponseDueAt: new Date(Date.now() - 60_000),
        nextDueAt: new Date(Date.now() - 60_000),
      },
    });
    const d = (await w.lead.client.get(`/api/v1/dashboard/teams/${w.team.id}`)).json as {
      agents: { id: string }[];
      unassignedCount: number;
      overdue: { id: string }[];
    };
    expect(d.agents.map((a) => a.id)).toEqual(
      expect.arrayContaining([w.agent.user.id, w.colleague.user.id]),
    );
    expect(d.unassignedCount).toBeGreaterThanOrEqual(1);
    expect(d.overdue.map((t) => t.id)).toContain(w.ticketId);
    expect((await w.agent.client.get(`/api/v1/dashboard/teams/${w.team.id}`)).status).toBe(404);
    const otherLead = await login(
      api,
      await createUserRow(db, { teams: [{ teamId: (await createTeamRow(db)).id, role: 'lead' }] }),
    );
    expect((await otherLead.client.get(`/api/v1/dashboard/teams/${w.team.id}`)).status).toBe(404);
  });

  it('report matches a hand-computed fixture: medians, p90, SLA share, breaches and ratings', async () => {
    const team = await createTeamRow(db);
    const agent = await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] });
    const lead = await login(
      api,
      await createUserRow(db, { teams: [{ teamId: team.id, role: 'lead' }] }),
    );
    const cust = await db.customer.create({ data: { email: `${uniq('c')}@x.test`, name: 'C' } });
    const base = new Date('2026-02-10T10:00:00Z');
    const mins = [10, 20, 30, 40, 100]; // first response minutes
    for (const [i, m] of mins.entries()) {
      const created = new Date(base.getTime() + i * 3600_000);
      const t = await db.ticket.create({
        data: {
          teamId: team.id,
          customerId: cust.id,
          subject: 's',
          status: 'closed',
          assigneeId: agent.id,
          createdAt: created,
          firstRespondedAt: new Date(created.getTime() + m * 60_000),
          resolvedAt: new Date(created.getTime() + (m + 60) * 60_000),
          firstResponseBreached: i === 4,
          closedAt: created,
        },
      });
      if (i < 3)
        await db.survey.create({
          data: {
            ticketId: t.id,
            tokenHash: uniq('h'),
            expiresAt: created,
            createdAt: created,
            rating: [5, 4, 3][i] ?? 5,
            ratedAt: created,
          },
        });
    }
    const r = (
      await lead.client.get(`/api/v1/reports?from=2026-02-10&to=2026-02-10&teamId=${team.id}`)
    ).json as {
      total: {
        tickets: number;
        firstResponseMedianMinutes: number;
        firstResponseP90Minutes: number;
        resolutionMedianMinutes: number;
        withinSlaPercent: number;
        breaches: number;
        ratingAverage: number;
        ratingCount: number;
      };
      byAgent: { agentId: string; tickets: number }[];
      ratingDistribution: { rating: number; count: number }[];
    };
    expect(r.total).toMatchObject({
      tickets: 5,
      firstResponseMedianMinutes: 30,
      resolutionMedianMinutes: 90,
      withinSlaPercent: 80,
      breaches: 1,
      ratingAverage: 4,
      ratingCount: 3,
    });
    expect(r.total.firstResponseP90Minutes).toBeCloseTo(76, 5); // percentile_cont(0.9) over 10,20,30,40,100
    expect(r.byAgent).toEqual([expect.objectContaining({ agentId: agent.id, tickets: 5 })]);
    expect(r.ratingDistribution).toEqual([
      { rating: 3, count: 1 },
      { rating: 4, count: 1 },
      { rating: 5, count: 1 },
    ]);
    const outside = (
      await lead.client.get(`/api/v1/reports?from=2026-03-01&to=2026-03-02&teamId=${team.id}`)
    ).json as { total: { tickets: number } };
    expect(outside.total.tickets).toBe(0);
    expect((await lead.client.get('/api/v1/reports?from=2026-02-11&to=2026-02-10')).status).toBe(
      400,
    );
  });

  it('reports are for leads and admins only, and a lead cannot read another team', async () => {
    const w = await world();
    expect((await w.agent.client.get('/api/v1/reports?from=2026-01-01&to=2026-01-31')).status).toBe(
      403,
    );
    const otherTeam = await createTeamRow(db);
    expect(
      (
        await w.lead.client.get(
          `/api/v1/reports?from=2026-01-01&to=2026-01-31&teamId=${otherTeam.id}`,
        )
      ).status,
    ).toBe(404);
    expect((await w.lead.client.get('/api/v1/reports?from=2026-01-01&to=2026-01-31')).status).toBe(
      200,
    );
  });
});
