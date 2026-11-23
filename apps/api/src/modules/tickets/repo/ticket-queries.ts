import type { Queryable } from '@helpdesk/core';
import { addBucket, emptyBucket, toStats, type Bucket } from '../domain/report-stats';

type Row = {
  id: string;
  number: bigint;
  subject: string;
  status: string;
  priority: string;
  language: string;
  team_id: string;
  assignee_id: string | null;
  assignee_name: string | null;
  customer_name: string;
  customer_email: string;
  created_at: Date;
  updated_at: Date;
  next_due_at: Date | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  sla_paused: boolean;
  first_responded_at: Date | null;
  first_response_breached: boolean;
  resolution_breached: boolean;
  version: number;
};

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export const toListItem = (r: Row) => ({
  id: r.id,
  number: Number(r.number),
  subject: r.subject,
  status: r.status as 'new' | 'open' | 'waiting_customer' | 'on_hold' | 'resolved' | 'closed',
  priority: r.priority as 'urgent' | 'high' | 'normal' | 'low',
  language: r.language as 'en' | 'uk' | 'pl' | 'de',
  teamId: r.team_id,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name,
  customerName: r.customer_name,
  customerEmail: r.customer_email,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  nextDueAt: iso(r.next_due_at),
  firstResponseDueAt: iso(r.first_response_due_at),
  resolutionDueAt: iso(r.resolution_due_at),
  slaPaused: r.sla_paused,
  firstRespondedAt: iso(r.first_responded_at),
  firstResponseBreached: r.first_response_breached,
  resolutionBreached: r.resolution_breached,
  version: r.version,
});

const COLS = `t.id, t.number, t.subject, t.status, t.priority, t.language, t.team_id, t.assignee_id, u.name AS assignee_name,
  c.name AS customer_name, c.email AS customer_email, t.created_at, t.updated_at, t.next_due_at, t.first_response_due_at,
  t.resolution_due_at, t.sla_paused, t.first_responded_at, t.first_response_breached, t.resolution_breached, t.version`;
const FROM = `FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assignee_id`;
const ACTIVE = `t.status IN ('new', 'open', 'waiting_customer', 'on_hold')`;

export type Scope = { readonly teamIds: readonly string[] | null };

/** The agent's own tickets, most urgent deadline first. Served by tickets_agent_queue_idx. */
export const agentQueue = async (db: Queryable, userId: string, limit: number) =>
  (
    await db.$queryRawUnsafe<Row[]>(
      `SELECT ${COLS} ${FROM} WHERE t.assignee_id = $1::uuid AND ${ACTIVE} ORDER BY t.next_due_at NULLS LAST, t.created_at LIMIT $2`,
      userId,
      limit,
    )
  ).map(toListItem);

/** Tickets waiting in team queues (no owner). Served by tickets_team_queue_idx. */
export const unassignedQueue = async (
  db: Queryable,
  scope: Scope,
  teamId: string | null,
  limit: number,
) =>
  (
    await db.$queryRawUnsafe<Row[]>(
      `SELECT ${COLS} ${FROM}
      WHERE t.assignee_id IS NULL AND ${ACTIVE}
        AND ($1::uuid[] IS NULL OR t.team_id = ANY($1::uuid[]))
        AND ($2::uuid IS NULL OR t.team_id = $2::uuid)
      ORDER BY t.next_due_at NULLS LAST, t.created_at LIMIT $3`,
      scope.teamIds === null ? null : [...scope.teamIds],
      teamId,
      limit,
    )
  ).map(toListItem);

export const getListItem = async (db: Queryable, id: string) =>
  (await db.$queryRawUnsafe<Row[]>(`SELECT ${COLS} ${FROM} WHERE t.id = $1::uuid`, id)).map(
    toListItem,
  )[0] ?? null;

/** Most matching messages considered for one search before ordering by recency. */
export const SEARCH_CANDIDATE_CAP = 2000;

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** Number, customer email/name, or full-text over correspondence and subjects, scoped to the caller's teams. */
export const searchTickets = async (
  db: Queryable,
  scope: Scope,
  q: string,
  limit: number,
  offset: number,
) => {
  const teams = scope.teamIds === null ? null : [...scope.teamIds];
  const cond = `($2::uuid[] IS NULL OR t.team_id = ANY($2::uuid[]))`;
  const number = /^#?(\d{4,12})$/.exec(q.trim());
  if (number?.[1] !== undefined) {
    return (
      await db.$queryRawUnsafe<Row[]>(
        `SELECT ${COLS} ${FROM} WHERE t.number = $1::bigint AND ${cond} LIMIT $3 OFFSET $4`,
        number[1],
        teams,
        limit,
        offset,
      )
    ).map((r) => ({ ...toListItem(r), snippet: null as string | null }));
  }
  if (q.includes('@')) {
    return (
      await db.$queryRawUnsafe<Row[]>(
        `SELECT ${COLS} ${FROM} WHERE c.email ILIKE $1 AND ${cond} ORDER BY t.updated_at DESC LIMIT $3 OFFSET $4`,
        `%${escapeLike(q.trim().toLowerCase())}%`,
        teams,
        limit,
        offset,
      )
    ).map((r) => ({ ...toListItem(r), snippet: null as string | null }));
  }
  // Candidates first, capped: a very common word can match millions of messages, and only the newest page is shown.
  // The cap is taken on the message index alone (fast), then the team filter and the ordering are applied to the candidates.
  // Team-scoped searches look at more candidates so other teams' messages do not crowd the result out.
  const cap = teams === null ? SEARCH_CANDIDATE_CAP : SEARCH_CANDIDATE_CAP * 4;
  const rows = await db.$queryRawUnsafe<(Row & { snippet: string | null })[]>(
    `WITH cand AS (
            (SELECT m.ticket_id AS id FROM messages m WHERE m.search_vector @@ websearch_to_tsquery('simple', $1) AND m.cancelled_at IS NULL LIMIT ${cap})
            UNION
            (SELECT t.id FROM tickets t WHERE t.subject_vector @@ websearch_to_tsquery('simple', $1) LIMIT ${cap})
          )
     SELECT ${COLS}, NULL::text AS snippet
       FROM cand h JOIN tickets t ON t.id = h.id JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ($2::uuid[] IS NULL OR t.team_id = ANY($2::uuid[]))
      ORDER BY t.updated_at DESC LIMIT $3 OFFSET $4`,
    q, teams, limit, offset,
  );
  const byName =
    rows.length >= limit
      ? []
      : await db.$queryRawUnsafe<Row[]>(
          `SELECT ${COLS} ${FROM} WHERE c.name ILIKE $1 AND ${cond} ORDER BY t.updated_at DESC LIMIT $3`,
          `%${escapeLike(q.trim())}%`,
          teams,
          limit - rows.length,
        );
  const seen = new Set(rows.map((r) => r.id));
  return [...rows, ...byName.filter((r) => !seen.has(r.id))].map((r) => ({
    ...toListItem(r),
    snippet: null as string | null,
  }));
};

export const teamDashboard = async (db: Queryable, teamId: string, now: Date) => {
  const agents = await db.$queryRawUnsafe<
    { id: string; name: string; on_shift: boolean; open_count: number; ticket_limit: number }[]
  >(
    `SELECT u.id, u.name, u.on_shift, u.open_count, u.ticket_limit FROM users u JOIN team_members m ON m.user_id = u.id
      WHERE m.team_id = $1::uuid AND m.role = 'agent' AND u.is_active ORDER BY u.name`,
    teamId,
  );
  const unassigned = await unassignedQueue(db, { teamIds: [teamId] }, teamId, 100);
  const count = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM tickets t WHERE t.team_id = $1::uuid AND t.assignee_id IS NULL AND ${ACTIVE}`,
    teamId,
  );
  const atRisk = (
    await db.$queryRawUnsafe<Row[]>(
      `SELECT ${COLS} ${FROM}
      WHERE t.team_id = $1::uuid AND ${ACTIVE}
        AND ((t.first_responded_at IS NULL AND t.first_response_warn_at <= $2 AND t.first_response_due_at > $2)
          OR (t.first_responded_at IS NOT NULL AND NOT t.sla_paused AND t.resolution_warn_at <= $2 AND t.resolution_due_at > $2))
      ORDER BY t.next_due_at NULLS LAST LIMIT 100`,
      teamId,
      now,
    )
  ).map(toListItem);
  const overdue = (
    await db.$queryRawUnsafe<Row[]>(
      `SELECT ${COLS} ${FROM}
      WHERE t.team_id = $1::uuid AND ${ACTIVE}
        AND ((t.first_responded_at IS NULL AND t.first_response_due_at <= $2)
          OR (t.first_responded_at IS NOT NULL AND NOT t.sla_paused AND t.resolution_due_at <= $2))
      ORDER BY t.next_due_at NULLS LAST LIMIT 100`,
      teamId,
      now,
    )
  ).map(toListItem);
  return {
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      onShift: a.on_shift,
      openCount: a.open_count,
      ticketLimit: a.ticket_limit,
    })),
    unassignedCount: Number(count[0]?.n ?? 0),
    unassigned,
    atRisk,
    overdue,
  };
};

export type ReportFilter = {
  readonly from: string;
  readonly to: string;
  readonly teamIds: readonly string[] | null;
  readonly agentId: string | null;
  readonly priority: string | null;
};

type GroupRow = {
  team_id: string; team_name: string; assignee_id: string | null; assignee_name: string | null; tickets: bigint;
  fr: number[] | null; res: number[] | null; decided: bigint; within: bigint; breaches: bigint; rating_sum: bigint | null; rating_count: bigint;
  r1: bigint; r2: bigint; r3: bigint; r4: bigint; r5: bigint;
};

const toBucket = (r: GroupRow): Bucket => ({
  tickets: Number(r.tickets), fr: (r.fr ?? []).map(Number), res: (r.res ?? []).map(Number), decided: Number(r.decided), within: Number(r.within), breaches: Number(r.breaches),
  ratingSum: Number(r.rating_sum ?? 0n), ratingCount: Number(r.rating_count), dist: [Number(r.r1), Number(r.r2), Number(r.r3), Number(r.r4), Number(r.r5)],
});

/**
 * Period report in one pass over the period's tickets (per-team index range scans, boundaries in each team's time zone).
 * The database groups by team and agent and returns the raw durations; percentiles are computed once from those.
 */
export const periodReport = async (db: Queryable, f: ReportFilter) => {
  const rows = await db.$queryRawUnsafe<GroupRow[]>(
    `WITH tr AS (
       SELECT id, ($1::date::timestamp AT TIME ZONE time_zone) AS lb, (($2::date + 1)::timestamp AT TIME ZONE time_zone) AS ub
         FROM teams WHERE ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
     ), g AS (
       SELECT t.team_id, t.assignee_id, count(*)::bigint AS tickets,
              array_agg(round(extract(epoch FROM (t.first_responded_at - t.created_at)) / 60)::int) FILTER (WHERE t.first_responded_at IS NOT NULL) AS fr,
              array_agg(round(extract(epoch FROM (t.resolved_at - t.created_at)) / 60)::int) FILTER (WHERE t.resolved_at IS NOT NULL) AS res,
              count(*) FILTER (WHERE t.resolved_at IS NOT NULL OR t.first_response_breached OR t.resolution_breached)::bigint AS decided,
              count(*) FILTER (WHERE (t.resolved_at IS NOT NULL OR t.first_response_breached OR t.resolution_breached)
                                 AND NOT t.first_response_breached AND NOT t.resolution_breached)::bigint AS within,
              count(*) FILTER (WHERE t.first_response_breached OR t.resolution_breached)::bigint AS breaches,
              sum(s.rating)::bigint AS rating_sum, count(s.rating)::bigint AS rating_count,
              count(*) FILTER (WHERE s.rating = 1) AS r1, count(*) FILTER (WHERE s.rating = 2) AS r2, count(*) FILTER (WHERE s.rating = 3) AS r3,
              count(*) FILTER (WHERE s.rating = 4) AS r4, count(*) FILTER (WHERE s.rating = 5) AS r5
         FROM tr
        CROSS JOIN LATERAL (
          SELECT id, team_id, assignee_id, created_at, first_responded_at, resolved_at, first_response_breached, resolution_breached
            FROM tickets t
           WHERE t.team_id = tr.id AND t.created_at >= tr.lb AND t.created_at < tr.ub AND t.merged_into_id IS NULL
             AND ($4::uuid IS NULL OR t.assignee_id = $4::uuid) AND ($5::text IS NULL OR t.priority = $5)
        ) t
        LEFT JOIN surveys s ON s.ticket_id = t.id AND s.rating IS NOT NULL
        GROUP BY t.team_id, t.assignee_id
     )
     SELECT g.*, tm.name AS team_name, u.name AS assignee_name FROM g JOIN teams tm ON tm.id = g.team_id LEFT JOIN users u ON u.id = g.assignee_id`,
    f.from, f.to, f.teamIds === null ? null : [...f.teamIds], f.agentId, f.priority,
  );
  const total = emptyBucket();
  const teams = new Map<string, { name: string; b: Bucket }>();
  const agents = new Map<string, { name: string; b: Bucket }>();
  for (const r of rows) {
    const b = toBucket(r);
    addBucket(total, b);
    const t = teams.get(r.team_id) ?? { name: r.team_name, b: emptyBucket() };
    addBucket(t.b, b);
    teams.set(r.team_id, t);
    const key = r.assignee_id ?? 'none';
    const a = agents.get(key) ?? { name: r.assignee_name ?? 'Unassigned', b: emptyBucket() };
    addBucket(a.b, b);
    agents.set(key, a);
  }
  return {
    total: toStats(total),
    byTeam: [...teams].map(([teamId, v]) => ({ teamId, teamName: v.name, ...toStats(v.b) })).sort((a, b) => a.teamName.localeCompare(b.teamName)),
    byAgent: [...agents].map(([id, v]) => ({ agentId: id === 'none' ? null : id, agentName: v.name, ...toStats(v.b) })).sort((a, b) => a.agentName.localeCompare(b.agentName)),
    ratingDistribution: total.dist.map((count, i) => ({ rating: i + 1, count })).filter((d) => d.count > 0),
  };
};
