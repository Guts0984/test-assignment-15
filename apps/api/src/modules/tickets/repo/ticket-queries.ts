import type { Queryable } from '@helpdesk/core';

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
  const rows = await db.$queryRawUnsafe<(Row & { snippet: string | null })[]>(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $1) AS tsq),
          hits AS (
            SELECT m.ticket_id AS id FROM messages m, q WHERE m.search_vector @@ q.tsq AND m.cancelled_at IS NULL
            UNION
            SELECT t.id FROM tickets t, q WHERE t.subject_vector @@ q.tsq
          )
     SELECT ${COLS}, NULL::text AS snippet
       FROM hits h JOIN tickets t ON t.id = h.id JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${cond}
      ORDER BY t.updated_at DESC LIMIT $3 OFFSET $4`,
    q,
    teams,
    limit,
    offset,
  );
  const byName =
    rows.length === 0 || rows.length >= limit
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

type StatRow = {
  tickets: bigint;
  fr_med: number | null;
  fr_p90: number | null;
  res_med: number | null;
  res_p90: number | null;
  decided: bigint;
  within: bigint;
  breaches: bigint;
  rating_avg: number | null;
  rating_count: bigint;
};

const STATS = `count(*)::bigint AS tickets,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t.first_responded_at - t.created_at)) / 60) FILTER (WHERE t.first_responded_at IS NOT NULL) AS fr_med,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (t.first_responded_at - t.created_at)) / 60) FILTER (WHERE t.first_responded_at IS NOT NULL) AS fr_p90,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE t.resolved_at IS NOT NULL) AS res_med,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE t.resolved_at IS NOT NULL) AS res_p90,
  count(*) FILTER (WHERE t.resolved_at IS NOT NULL OR t.first_response_breached OR t.resolution_breached)::bigint AS decided,
  count(*) FILTER (WHERE (t.resolved_at IS NOT NULL OR t.first_response_breached OR t.resolution_breached) AND NOT t.first_response_breached AND NOT t.resolution_breached)::bigint AS within,
  count(*) FILTER (WHERE t.first_response_breached OR t.resolution_breached)::bigint AS breaches,
  avg(s.rating)::float AS rating_avg, count(s.rating)::bigint AS rating_count`;

const toStats = (r: StatRow) => ({
  tickets: Number(r.tickets),
  firstResponseMedianMinutes: r.fr_med,
  firstResponseP90Minutes: r.fr_p90,
  resolutionMedianMinutes: r.res_med,
  resolutionP90Minutes: r.res_p90,
  withinSlaPercent:
    Number(r.decided) === 0 ? null : Math.round((Number(r.within) / Number(r.decided)) * 1000) / 10,
  breaches: Number(r.breaches),
  ratingAverage: r.rating_avg === null ? null : Math.round(r.rating_avg * 100) / 100,
  ratingCount: Number(r.rating_count),
});

export type ReportFilter = {
  readonly from: string;
  readonly to: string;
  readonly teamIds: readonly string[] | null;
  readonly agentId: string | null;
  readonly priority: string | null;
};

const REPORT_FROM = `FROM tickets t JOIN teams tm ON tm.id = t.team_id LEFT JOIN surveys s ON s.ticket_id = t.id AND s.rating IS NOT NULL`;
const REPORT_WHERE = `t.created_at >= ($1::date::timestamp AT TIME ZONE tm.time_zone)
  AND t.created_at < (($2::date + 1)::timestamp AT TIME ZONE tm.time_zone)
  AND ($3::uuid[] IS NULL OR t.team_id = ANY($3::uuid[]))
  AND ($4::uuid IS NULL OR t.assignee_id = $4::uuid)
  AND ($5::text IS NULL OR t.priority = $5)
  AND t.merged_into_id IS NULL`;

export const periodReport = async (db: Queryable, f: ReportFilter) => {
  const args = [f.from, f.to, f.teamIds === null ? null : [...f.teamIds], f.agentId, f.priority];
  const total = await db.$queryRawUnsafe<StatRow[]>(
    `SELECT ${STATS} ${REPORT_FROM} WHERE ${REPORT_WHERE}`,
    ...args,
  );
  const byTeam = await db.$queryRawUnsafe<(StatRow & { team_id: string; team_name: string })[]>(
    `SELECT tm.id AS team_id, tm.name AS team_name, ${STATS} ${REPORT_FROM} WHERE ${REPORT_WHERE} GROUP BY tm.id, tm.name ORDER BY tm.name`,
    ...args,
  );
  const byAgent = await db.$queryRawUnsafe<
    (StatRow & { agent_id: string | null; agent_name: string | null })[]
  >(
    `SELECT t.assignee_id AS agent_id, u.name AS agent_name, ${STATS}
       ${REPORT_FROM} LEFT JOIN users u ON u.id = t.assignee_id WHERE ${REPORT_WHERE} GROUP BY t.assignee_id, u.name ORDER BY u.name NULLS LAST`,
    ...args,
  );
  const dist = await db.$queryRawUnsafe<{ rating: number; n: bigint }[]>(
    `SELECT s.rating, count(*)::bigint AS n ${REPORT_FROM} WHERE ${REPORT_WHERE} AND s.rating IS NOT NULL GROUP BY s.rating ORDER BY s.rating`,
    ...args,
  );
  const empty: StatRow = {
    tickets: 0n,
    fr_med: null,
    fr_p90: null,
    res_med: null,
    res_p90: null,
    decided: 0n,
    within: 0n,
    breaches: 0n,
    rating_avg: null,
    rating_count: 0n,
  };
  return {
    total: toStats(total[0] ?? empty),
    byTeam: byTeam.map((r) => ({ teamId: r.team_id, teamName: r.team_name, ...toStats(r) })),
    byAgent: byAgent.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name ?? 'Unassigned',
      ...toStats(r),
    })),
    ratingDistribution: dist.map((d) => ({ rating: d.rating, count: Number(d.n) })),
  };
};
