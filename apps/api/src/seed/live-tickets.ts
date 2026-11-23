import { randomUUID } from 'node:crypto';
import {
  computeSlaDeadlines,
  nextDueAt,
  type HoursCalendar,
  type Language,
  type Pause,
  type Priority,
  type SlaDeadlines,
  type TicketStatus,
} from '@helpdesk/shared';
import type { Rng } from './rng';

export type LiveTeam = {
  readonly id: string;
  readonly calendar: HoursCalendar;
  readonly mailbox: string;
};

export type LiveAgent = {
  readonly id: string;
  readonly teamId: string;
  readonly limit: number;
  readonly languages: readonly Language[];
  readonly onShift: boolean;
};

export type LiveTicket = {
  readonly id: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: Priority;
  readonly language: Language;
  readonly teamId: string;
  readonly customerId: string;
  readonly assigneeId: string | null;
  readonly mailboxAddress: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly queuedAt: Date | null;
  readonly firstRespondedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly lastCustomerMsgAt: Date;
  readonly lastPublicReplyAt: Date | null;
  readonly sla: SlaDeadlines;
  readonly nextDueAt: Date | null;
  readonly firstResponseBreached: boolean;
  readonly resolutionBreached: boolean;
  readonly messageSeq: number;
};

export type LiveMessage = {
  readonly ticketId: string;
  readonly seq: number;
  readonly kind: 'public' | 'note';
  readonly direction: 'inbound' | 'outbound' | 'internal';
  readonly authorKind: 'customer' | 'agent';
  readonly authorUserId: string | null;
  readonly body: string;
  readonly createdAt: Date;
  readonly releasedAt: Date | null;
};

export type LiveEvent = {
  readonly ticketId: string;
  readonly type: string;
  readonly actorKind: 'system' | 'customer' | 'agent';
  readonly actorUserId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
};

export type LiveJob = {
  readonly kind: 'sla_warning' | 'sla_breach' | 'auto_close';
  readonly ref: string;
  readonly dedupeKey: string;
  readonly runAt: Date;
  readonly status: 'pending' | 'done';
  readonly payload: Readonly<Record<string, unknown>>;
};

export type LivePause = {
  readonly ticketId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
};

export type LiveSet = {
  readonly tickets: readonly LiveTicket[];
  readonly messages: readonly LiveMessage[];
  readonly events: readonly LiveEvent[];
  readonly jobs: readonly LiveJob[];
  readonly pauses: readonly LivePause[];
};

export type LiveInput = {
  readonly now: Date;
  readonly rng: Rng;
  readonly teams: readonly LiveTeam[];
  readonly agents: readonly LiveAgent[];
  readonly customerIds: readonly string[];
  readonly subjects: readonly string[];
  readonly bodies: readonly string[];
  readonly active: number;
  readonly breachSoon: number;
  readonly warnSoon: number;
  readonly resolved: number;
  readonly warningRatio: number;
};

const MIN = 60_000;
const HOUR = 3_600_000;

type Kind = 'breachSoon' | 'warnSoon' | 'general' | 'resolved';

const pickPriority = (rng: Rng): Priority => {
  const r = rng.next();
  return r < 0.07 ? 'urgent' : r < 0.3 ? 'high' : r < 0.82 ? 'normal' : 'low';
};

const teamLanguage = (rng: Rng, agentsOfTeam: readonly LiveAgent[]): Language => {
  const langs = [...new Set(agentsOfTeam.flatMap((a) => a.languages))];
  return rng.chance(0.75) ? 'en' : (rng.pick(langs) as Language);
};

/**
 * Builds the open tickets with running SLA timers, all relative to `now`.
 * Deadlines come from the real shared calculator, so they match what the system computes later.
 */
export const buildLiveSet = (input: LiveInput): LiveSet => {
  const { now, rng } = input;
  const load = new Map<string, number>(input.agents.map((a) => [a.id, 0]));
  const tickets: LiveTicket[] = [];
  const messages: LiveMessage[] = [];
  const events: LiveEvent[] = [];
  const jobs: LiveJob[] = [];
  const pauses: LivePause[] = [];
  const nowMs = now.getTime();

  const kinds: Kind[] = [
    ...Array<Kind>(input.breachSoon).fill('breachSoon'),
    ...Array<Kind>(input.warnSoon).fill('warnSoon'),
    ...Array<Kind>(Math.max(0, input.active - input.breachSoon - input.warnSoon)).fill('general'),
    ...Array<Kind>(input.resolved).fill('resolved'),
  ];

  for (const kind of kinds) {
    const team = rng.pick(input.teams);
    const teamAgents = input.agents.filter((a) => a.teamId === team.id);
    const language = teamLanguage(rng, teamAgents);
    const priority: Priority =
      kind === 'breachSoon' || kind === 'warnSoon' ? 'urgent' : pickPriority(rng);
    const id = randomUUID();

    let createdMs: number;
    if (kind === 'breachSoon') createdMs = nowMs - rng.int(50 * 60, 59 * 60) * 1000;
    else if (kind === 'warnSoon')
      createdMs = nowMs - rng.int(3 * 3600 + 2 * 60, 3 * 3600 + 11 * 60) * 1000;
    else if (kind === 'resolved') createdMs = nowMs - rng.int(30, 110) * HOUR;
    else createdMs = nowMs - Math.floor(Math.pow(rng.next(), 1.6) * 4 * 24 * HOUR) - 20 * MIN;
    const createdAt = new Date(createdMs);

    const responded =
      kind === 'warnSoon' || kind === 'resolved' || (kind === 'general' && rng.chance(0.6));
    const firstRespondedMs = responded
      ? createdMs + (kind === 'warnSoon' ? rng.int(5, 20) * MIN : rng.int(5, 180) * MIN)
      : null;
    const clampedRespondedMs =
      firstRespondedMs === null ? null : Math.min(firstRespondedMs, nowMs - MIN);
    const firstRespondedAt = clampedRespondedMs === null ? null : new Date(clampedRespondedMs);

    let status: TicketStatus;
    let resolvedAt: Date | null = null;
    const ticketPauses: Pause[] = [];
    if (kind === 'resolved') {
      status = 'resolved';
      resolvedAt = new Date(nowMs - rng.int(1, 70) * HOUR);
      if (resolvedAt.getTime() <= (clampedRespondedMs ?? createdMs))
        resolvedAt = new Date(nowMs - 30 * MIN);
    } else if (kind === 'breachSoon') status = 'new';
    else if (kind === 'warnSoon') status = 'open';
    else if (!responded) status = 'new';
    else {
      const r = rng.next();
      status = r < 0.7 ? 'open' : r < 0.85 ? 'waiting_customer' : 'on_hold';
    }
    if (status === 'waiting_customer' && clampedRespondedMs !== null) {
      const start = Math.min(nowMs - MIN, clampedRespondedMs + rng.int(1, 120) * MIN);
      ticketPauses.push({ startedAt: new Date(start), endedAt: null });
    }
    if (
      kind === 'general' &&
      responded &&
      status === 'open' &&
      rng.chance(0.25) &&
      clampedRespondedMs !== null
    ) {
      const s = clampedRespondedMs + 10 * MIN;
      if (s + 30 * MIN < nowMs)
        ticketPauses.push({ startedAt: new Date(s), endedAt: new Date(s + rng.int(20, 90) * MIN) });
    }

    const computed = computeSlaDeadlines({
      priority,
      createdAt,
      calendar: team.calendar,
      pauses: ticketPauses,
      warningRatio: input.warningRatio,
    });
    if (!computed.ok) throw new Error(`SLA calculation failed for seed ticket: ${computed.error}`);
    const sla = computed.value;

    // Assignment mirrors the real rule: fewest open tickets among on-shift agents under their limit.
    const counts = status !== 'resolved';
    const eligible = teamAgents
      .filter(
        (a) =>
          a.onShift &&
          a.languages.includes(language) &&
          (!counts || (load.get(a.id) ?? 0) < a.limit),
      )
      .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
    const fallback = teamAgents.filter(
      (a) => a.onShift && (!counts || (load.get(a.id) ?? 0) < a.limit),
    );
    const assignee = eligible[0] ?? (kind === 'resolved' ? fallback[0] : undefined) ?? null;
    const unassigned = status === 'new' && kind !== 'breachSoon' && assignee === null;
    const chosen = status === 'resolved' ? (eligible[0] ?? fallback[0] ?? null) : assignee;
    if (chosen !== null && counts) load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1);

    const firstBreached = (firstRespondedAt?.getTime() ?? nowMs) > sla.firstResponseDueAt.getTime();
    const resBreached =
      sla.resolutionDueAt !== null &&
      (resolvedAt?.getTime() ?? nowMs) > sla.resolutionDueAt.getTime();

    // Messages: customer opens, agent answers, optional follow-ups and a note.
    let seq = 0;
    const subject = input.subjects[rng.int(0, input.subjects.length - 1)] ?? 'Help needed';
    const body = (): string => input.bodies[rng.int(0, input.bodies.length - 1)] ?? 'Hello';
    const addMessage = (m: Omit<LiveMessage, 'ticketId' | 'seq'>): void => {
      seq += 1;
      messages.push({ ticketId: id, seq, ...m });
    };
    addMessage({
      kind: 'public',
      direction: 'inbound',
      authorKind: 'customer',
      authorUserId: null,
      body: body(),
      createdAt,
      releasedAt: null,
    });
    let lastReply: Date | null = null;
    let lastCustomer: Date = createdAt;
    if (firstRespondedAt !== null) {
      addMessage({
        kind: 'public',
        direction: 'outbound',
        authorKind: 'agent',
        authorUserId: chosen?.id ?? null,
        body: body(),
        createdAt: firstRespondedAt,
        releasedAt: firstRespondedAt,
      });
      lastReply = firstRespondedAt;
      if (rng.chance(0.35) && status !== 'waiting_customer') {
        const at = new Date(
          Math.min(nowMs - MIN, firstRespondedAt.getTime() + rng.int(10, 240) * MIN),
        );
        addMessage({
          kind: 'public',
          direction: 'inbound',
          authorKind: 'customer',
          authorUserId: null,
          body: body(),
          createdAt: at,
          releasedAt: null,
        });
        lastCustomer = at;
      }
      if (rng.chance(0.3)) {
        addMessage({
          kind: 'note',
          direction: 'internal',
          authorKind: 'agent',
          authorUserId: chosen?.id ?? null,
          body: body(),
          createdAt: new Date(Math.min(nowMs - MIN, firstRespondedAt.getTime() + 5 * MIN)),
          releasedAt: null,
        });
      }
    }

    // History.
    const ev = (
      type: string,
      actor: 'system' | 'customer' | 'agent',
      at: Date,
      data: Record<string, unknown> = {},
      userId: string | null = null,
    ): void => {
      events.push({
        ticketId: id,
        type,
        actorKind: actor,
        actorUserId: userId,
        data,
        createdAt: at,
      });
    };
    ev('created', 'customer', createdAt, { priority, teamId: team.id });
    if (chosen !== null)
      ev('assigned', 'system', new Date(createdMs + 2000), { assigneeId: chosen.id, auto: true });
    if (firstRespondedAt !== null) ev('reply', 'agent', firstRespondedAt, {}, chosen?.id ?? null);
    if (status !== 'new' && firstRespondedAt !== null)
      ev('status_changed', 'system', firstRespondedAt, {
        from: 'new',
        to: status === 'resolved' ? 'open' : status,
      });
    if (resolvedAt !== null)
      ev(
        'status_changed',
        'agent',
        resolvedAt,
        { from: 'open', to: 'resolved' },
        chosen?.id ?? null,
      );
    for (const p of ticketPauses)
      ev(
        'status_changed',
        'agent',
        p.startedAt,
        { from: 'open', to: 'waiting_customer' },
        chosen?.id ?? null,
      );

    // SLA timers: events that already passed are history, future ones are pending jobs.
    const sla1 = (
      target: 'first_response' | 'resolution',
      warn: Date | null,
      due: Date | null,
      finished: boolean,
    ): void => {
      if (finished || warn === null || due === null) return;
      for (const [event, at] of [
        ['warning', warn],
        ['breach', due],
      ] as const) {
        const past = at.getTime() <= nowMs;
        jobs.push({
          kind: event === 'warning' ? 'sla_warning' : 'sla_breach',
          ref: id,
          dedupeKey: `sla:${id}:${target}:${event}`,
          runAt: at,
          status: past ? 'done' : 'pending',
          payload: { ticketId: id, target },
        });
        if (past) ev(event === 'warning' ? 'sla_warning' : 'sla_breach', 'system', at, { target });
      }
    };
    sla1(
      'first_response',
      sla.firstResponseWarnAt,
      sla.firstResponseDueAt,
      firstRespondedAt !== null,
    );
    sla1(
      'resolution',
      sla.resolutionWarnAt,
      sla.resolutionDueAt,
      resolvedAt !== null || sla.paused,
    );
    if (resolvedAt !== null) {
      jobs.push({
        kind: 'auto_close',
        ref: id,
        dedupeKey: `auto_close:${id}`,
        runAt: new Date(resolvedAt.getTime() + 72 * HOUR),
        status: 'pending',
        payload: { ticketId: id },
      });
    }
    for (const p of ticketPauses)
      pauses.push({ ticketId: id, startedAt: p.startedAt, endedAt: p.endedAt });

    const updatedAt = new Date(
      Math.max(
        lastCustomer.getTime(),
        lastReply?.getTime() ?? 0,
        resolvedAt?.getTime() ?? 0,
        createdMs + 2000,
      ),
    );
    tickets.push({
      id,
      subject,
      status,
      priority,
      language,
      teamId: team.id,
      customerId: input.customerIds[rng.int(0, input.customerIds.length - 1)] as string,
      assigneeId: unassigned ? null : (chosen?.id ?? null),
      mailboxAddress: team.mailbox,
      createdAt,
      updatedAt,
      queuedAt: unassigned || chosen === null ? createdAt : null,
      firstRespondedAt,
      resolvedAt,
      lastCustomerMsgAt: lastCustomer,
      lastPublicReplyAt: lastReply,
      sla,
      nextDueAt: nextDueAt(sla, { firstRespondedAt, resolvedAt }),
      firstResponseBreached: firstRespondedAt === null ? firstBreached : firstBreached,
      resolutionBreached: resBreached,
      messageSeq: seq,
    });
  }
  return { tickets, messages, events, jobs, pauses };
};
