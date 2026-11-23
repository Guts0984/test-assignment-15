import {
  collectorOf,
  flushCollector,
  dbBusinessError,
  inTx,
  isUniqueViolation,
  requestTeamAssignments,
  returnAgentTicketsToQueue,
  type Db,
  type RealtimePublisher,
  type Tx,
} from '@helpdesk/core';
import {
  err,
  hhmmOf,
  minutesOf,
  ok,
  type AgentInput,
  type Clock,
  type Result,
  type RoutingRuleInput,
  type TeamInput,
} from '@helpdesk/shared';
import { hashPassword, type PasswordCost } from '../../infra/password';

export type AdminDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly cost: PasswordCost;
  readonly publisher: RealtimePublisher;
  readonly revoker: {
    leaveTeam: (userId: string, teamId: string) => void;
    disconnectUser: (userId: string) => void;
  };
};
export type AdminFailure = 'NOT_FOUND' | 'CONFLICT';

const teamSelect = {
  id: true,
  name: true,
  timeZone: true,
  workdays: true,
  workStartMin: true,
  workEndMin: true,
  defaultLanguage: true,
} as const;

type TeamRow = {
  id: string;
  name: string;
  timeZone: string;
  workdays: number[];
  workStartMin: number;
  workEndMin: number;
  defaultLanguage: string;
};

export const toTeamView = (t: TeamRow) => ({
  id: t.id,
  name: t.name,
  timeZone: t.timeZone,
  workdays: [...t.workdays].sort((a, b) => a - b),
  workStart: hhmmOf(t.workStartMin),
  workEnd: hhmmOf(t.workEndMin),
  defaultLanguage: t.defaultLanguage as 'en' | 'uk' | 'pl' | 'de',
});

const agentSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  onShift: true,
  ticketLimit: true,
  languages: true,
  isActive: true,
  openCount: true,
  memberships: { select: { teamId: true, role: true } },
} as const;

type AgentRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  onShift: boolean;
  ticketLimit: number;
  languages: string[];
  isActive: boolean;
  openCount: number;
  memberships: { teamId: string; role: string }[];
};

const toAgentView = (u: AgentRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role as 'admin' | 'staff',
  onShift: u.onShift,
  ticketLimit: u.ticketLimit,
  languages: u.languages as ('en' | 'uk' | 'pl' | 'de')[],
  memberships: u.memberships as { teamId: string; role: 'agent' | 'lead' }[],
  active: u.isActive,
  openCount: u.openCount,
});

const mapDbFailure = (e: unknown): AdminFailure | null => {
  if (isUniqueViolation(e)) return 'CONFLICT';
  const code = (e as { code?: string }).code;
  if (code === 'P2003' || code === 'P2025') return 'NOT_FOUND';
  return null;
};

const guard = async <T>(fn: () => Promise<T>): Promise<Result<T, AdminFailure>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const f = mapDbFailure(e);
    if (f === null || dbBusinessError(e) !== null) throw e;
    return err(f);
  }
};

export const createAdmin = (d: AdminDeps) => ({
  listTeams: async () =>
    (await d.db.team.findMany({ select: teamSelect, orderBy: { name: 'asc' } })).map(toTeamView),

  createTeam: (i: TeamInput) =>
    guard(async () =>
      toTeamView(
        await d.db.team.create({
          data: {
            name: i.name,
            timeZone: i.timeZone,
            workdays: i.workdays,
            workStartMin: minutesOf(i.workStart),
            workEndMin: minutesOf(i.workEnd),
            defaultLanguage: i.defaultLanguage,
          },
          select: teamSelect,
        }),
      ),
    ),

  updateTeam: (
    id: string,
    i: Omit<TeamInput, 'name' | 'defaultLanguage'> &
      Partial<Pick<TeamInput, 'name' | 'defaultLanguage'>>,
  ) =>
    guard(async () =>
      toTeamView(
        await d.db.team.update({
          where: { id },
          data: {
            ...(i.name === undefined ? {} : { name: i.name }),
            ...(i.defaultLanguage === undefined ? {} : { defaultLanguage: i.defaultLanguage }),
            timeZone: i.timeZone,
            workdays: i.workdays,
            workStartMin: minutesOf(i.workStart),
            workEndMin: minutesOf(i.workEnd),
          },
          select: teamSelect,
        }),
      ),
    ),

  listHolidays: async (teamId: string) =>
    (await d.db.teamHoliday.findMany({ where: { teamId }, orderBy: { date: 'asc' } })).map((h) => ({
      id: h.id,
      date: h.date.toISOString().slice(0, 10),
      name: h.name,
    })),

  addHoliday: (teamId: string, i: { date: string; name: string }) =>
    guard(async () => {
      const h = await d.db.teamHoliday.create({
        data: { teamId, date: new Date(`${i.date}T00:00:00Z`), name: i.name },
      });
      return { id: h.id, date: i.date, name: h.name };
    }),

  removeHoliday: (teamId: string, holidayId: string) =>
    guard(async () => {
      const r = await d.db.teamHoliday.deleteMany({ where: { id: holidayId, teamId } });
      if (r.count === 0) throw Object.assign(new Error('missing'), { code: 'P2025' });
      return { ok: true as const };
    }),

  listAgents: async () =>
    (
      await d.db.user.findMany({
        where: { memberships: { some: {} } },
        select: agentSelect,
        orderBy: { email: 'asc' },
      })
    ).map(toAgentView),

  createAgent: (i: AgentInput) =>
    guard(async () => {
      const passwordHash = await hashPassword(
        i.password ?? `unusable-${Math.random()}-${Date.now()}`,
        d.cost,
      );
      const u = await d.db.user.create({
        data: {
          email: i.email,
          name: i.name,
          passwordHash,
          ticketLimit: i.ticketLimit,
          languages: i.languages,
          isActive: i.active,
          memberships: { create: i.memberships.map((m) => ({ teamId: m.teamId, role: m.role })) },
        },
        select: agentSelect,
      });
      return toAgentView(u);
    }),

  /** Replaces profile and memberships; removing someone from a team (or deactivating) returns their tickets to the queue. */
  updateAgent: (id: string, i: AgentInput) =>
    guard(async () => {
      const ref: { tx: Tx | null; removed: string[] } = { tx: null, removed: [] };
      const view = await inTx(d.db, async (tx) => {
        ref.tx = tx;
        const now = d.clock.now();
        const before = await tx.user.findUnique({
          where: { id },
          select: { memberships: { select: { teamId: true } } },
        });
        if (before === null) throw Object.assign(new Error('missing'), { code: 'P2025' });
        const keep = new Set(i.memberships.map((m) => m.teamId));
        const removed = before.memberships.map((m) => m.teamId).filter((t) => !keep.has(t));
        ref.removed = removed;
        await tx.teamMember.deleteMany({ where: { userId: id } });
        await tx.user.update({
          where: { id },
          data: {
            email: i.email,
            name: i.name,
            ticketLimit: i.ticketLimit,
            languages: i.languages,
            isActive: i.active,
            ...(i.password === undefined
              ? {}
              : { passwordHash: await hashPassword(i.password, d.cost) }),
            ...(i.active ? {} : { tokenVersion: { increment: 1 }, onShift: false }),
            memberships: { create: i.memberships.map((m) => ({ teamId: m.teamId, role: m.role })) },
          },
        });
        const affected: string[] = [];
        if (!i.active) {
          const r = await returnAgentTicketsToQueue(tx, {
            agentId: id,
            reason: 'deactivated',
            now,
          });
          affected.push(...r.teamIds);
          await tx.refreshToken.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: now },
          });
        } else {
          for (const teamId of removed) {
            const r = await returnAgentTicketsToQueue(tx, {
              agentId: id,
              teamId,
              reason: 'removed_from_team',
              now,
            });
            affected.push(...r.teamIds);
          }
        }
        await requestTeamAssignments(tx, [...new Set(affected)], now);
        return toAgentView(await tx.user.findUniqueOrThrow({ where: { id }, select: agentSelect }));
      });
      if (ref.tx !== null)
        await flushCollector(d.db, collectorOf(ref.tx), d.publisher).catch(() => undefined);
      if (!i.active) d.revoker.disconnectUser(id);
      else for (const teamId of ref.removed) d.revoker.leaveTeam(id, teamId);
      return view;
    }),

  /** Lowering a limit below the current load is allowed: the agent simply gets nothing new until under it. */
  updateLimits: (
    id: string,
    i: { ticketLimit: number; languages?: ('en' | 'uk' | 'pl' | 'de')[] },
  ) =>
    guard(async () =>
      toAgentView(
        await d.db.user.update({
          where: { id },
          data: {
            ticketLimit: i.ticketLimit,
            ...(i.languages === undefined ? {} : { languages: i.languages }),
          },
          select: agentSelect,
        }),
      ),
    ),

  listRules: async () =>
    (await d.db.routingRule.findMany({ orderBy: { position: 'asc' } })).map(toRuleView),
  createRule: (i: RoutingRuleInput) =>
    guard(async () => toRuleView(await d.db.routingRule.create({ data: ruleData(i) }))),
  updateRule: (id: string, i: RoutingRuleInput) =>
    guard(async () =>
      toRuleView(await d.db.routingRule.update({ where: { id }, data: ruleData(i) })),
    ),
  deleteRule: (id: string) =>
    guard(async () => {
      await d.db.routingRule.delete({ where: { id } });
      return { ok: true as const };
    }),

  listMailboxes: () =>
    d.db.mailbox.findMany({
      select: { address: true, defaultTeamId: true },
      orderBy: { address: 'asc' },
    }),
  createMailbox: (i: { address: string; defaultTeamId: string }) =>
    guard(() => d.db.mailbox.create({ data: i, select: { address: true, defaultTeamId: true } })),
  deleteMailbox: (address: string) =>
    guard(async () => {
      await d.db.mailbox.delete({ where: { address } });
      return { ok: true as const };
    }),

  /** Jobs that exhausted their retries; the administrator can inspect and retry them. */
  listFailedJobs: async () =>
    (
      await d.db.job.findMany({
        where: { status: 'dead' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    ).map((j) => ({
      id: String(j.id),
      kind: j.kind,
      ref: j.ref,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError,
      runAt: j.runAt.toISOString(),
      createdAt: j.createdAt.toISOString(),
    })),

  retryFailedJob: (id: string) =>
    guard(async () => {
      const r = await d.db.$executeRaw`
        UPDATE jobs SET status = 'pending', attempts = 0, run_at = ${d.clock.now()}, last_error = NULL, completed_at = NULL
         WHERE id = ${BigInt(id)} AND status = 'dead'`;
      if (r === 0) throw Object.assign(new Error('missing'), { code: 'P2025' });
      return { ok: true as const };
    }),
});

const ruleData = (i: RoutingRuleInput) => ({
  position: i.position,
  enabled: i.enabled,
  recipient: i.recipient,
  subjectKeywords: i.subjectKeywords,
  language: i.language,
  teamId: i.teamId,
  priority: i.priority,
});

const toRuleView = (r: {
  id: string;
  position: number;
  enabled: boolean;
  recipient: string | null;
  subjectKeywords: string[];
  language: string | null;
  teamId: string;
  priority: string | null;
}) => ({
  id: r.id,
  position: r.position,
  enabled: r.enabled,
  recipient: r.recipient,
  subjectKeywords: r.subjectKeywords,
  language: r.language as 'en' | 'uk' | 'pl' | 'de' | null,
  teamId: r.teamId,
  priority: r.priority as 'urgent' | 'high' | 'normal' | 'low' | null,
});

export type AdminUseCases = ReturnType<typeof createAdmin>;
