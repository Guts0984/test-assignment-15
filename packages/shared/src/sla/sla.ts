import type { Priority } from '../domain/constants';
import { ok, type Result } from '../result/result';
import {
  addBusinessMs,
  ALWAYS,
  businessDayMs,
  businessMsBetween,
  type BusinessCalendar,
  type BusinessTimeError,
} from '../business-time/business-time';

const HOUR_MS = 3_600_000;

type Target =
  | { readonly unit: 'hours'; readonly amount: number }
  | { readonly unit: 'businessDays'; readonly amount: number };

type PolicyEntry = {
  /** `urgent` runs around the clock; the others follow the team calendar. */
  readonly wallClock: boolean;
  readonly firstResponse: Target;
  readonly resolution: Target;
};

export const SLA_POLICY: Readonly<Record<Priority, PolicyEntry>> = {
  urgent: {
    wallClock: true,
    firstResponse: { unit: 'hours', amount: 1 },
    resolution: { unit: 'hours', amount: 4 },
  },
  high: {
    wallClock: false,
    firstResponse: { unit: 'hours', amount: 4 },
    resolution: { unit: 'businessDays', amount: 1 },
  },
  normal: {
    wallClock: false,
    firstResponse: { unit: 'hours', amount: 8 },
    resolution: { unit: 'businessDays', amount: 3 },
  },
  low: {
    wallClock: false,
    firstResponse: { unit: 'businessDays', amount: 2 },
    resolution: { unit: 'businessDays', amount: 5 },
  },
};

export type Pause = { readonly startedAt: Date; readonly endedAt: Date | null };

export type SlaInput = {
  readonly priority: Priority;
  readonly createdAt: Date;
  readonly calendar: BusinessCalendar;
  /** Periods spent in `waiting_customer`. An open pause (endedAt null) suspends the resolution deadline. */
  readonly pauses: readonly Pause[];
  readonly warningRatio: number;
};

export type SlaDeadlines = {
  readonly firstResponseDueAt: Date;
  readonly firstResponseWarnAt: Date;
  /** Null while the ticket is paused. */
  readonly resolutionDueAt: Date | null;
  readonly resolutionWarnAt: Date | null;
  readonly paused: boolean;
};

export const calendarFor = (
  priority: Priority,
  teamCalendar: BusinessCalendar,
): BusinessCalendar => (SLA_POLICY[priority].wallClock ? ALWAYS : teamCalendar);

const targetMs = (t: Target, cal: BusinessCalendar): number =>
  t.unit === 'hours' ? t.amount * HOUR_MS : t.amount * businessDayMs(cal);

/**
 * Deadline for `durationMs` of business time counted from `createdMs`, where each pause
 * extends the deadline by the business time it covered before the deadline.
 * Solved as a fixed point because a pause that starts after the first guess may still matter.
 */
const dueWithPauses = (
  cal: BusinessCalendar,
  createdMs: number,
  durationMs: number,
  pauses: readonly { readonly startMs: number; readonly endMs: number }[],
): Result<number, BusinessTimeError> => {
  const base = addBusinessMs(cal, createdMs, durationMs);
  if (!base.ok) return base;
  let due = base.value;
  for (let i = 0; i <= pauses.length + 1; i += 1) {
    const paused = pauses.reduce(
      (sum, p) =>
        sum + businessMsBetween(cal, Math.max(p.startMs, createdMs), Math.min(p.endMs, due)),
      0,
    );
    const next = addBusinessMs(cal, createdMs, durationMs + paused);
    if (!next.ok) return next;
    if (next.value === due) return ok(due);
    due = next.value;
  }
  return ok(due);
};

/**
 * Computes all SLA deadlines from the ticket creation time. Used on creation and again,
 * from scratch, on every priority or team change and on every pause start/end.
 */
export const computeSlaDeadlines = (input: SlaInput): Result<SlaDeadlines, BusinessTimeError> => {
  const policy = SLA_POLICY[input.priority];
  const cal = calendarFor(input.priority, input.calendar);
  const createdMs = input.createdAt.getTime();
  const firstMs = targetMs(policy.firstResponse, cal);
  const resolutionMs = targetMs(policy.resolution, cal);

  const firstDue = addBusinessMs(cal, createdMs, firstMs);
  const firstWarn = addBusinessMs(cal, createdMs, firstMs * input.warningRatio);
  if (!firstDue.ok) return firstDue;
  if (!firstWarn.ok) return firstWarn;

  const paused = input.pauses.some((p) => p.endedAt === null);
  if (paused) {
    return ok({
      firstResponseDueAt: new Date(firstDue.value),
      firstResponseWarnAt: new Date(firstWarn.value),
      resolutionDueAt: null,
      resolutionWarnAt: null,
      paused: true,
    });
  }
  const closed = input.pauses.flatMap((p) =>
    p.endedAt === null ? [] : [{ startMs: p.startedAt.getTime(), endMs: p.endedAt.getTime() }],
  );
  const resDue = dueWithPauses(cal, createdMs, resolutionMs, closed);
  const resWarn = dueWithPauses(cal, createdMs, resolutionMs * input.warningRatio, closed);
  if (!resDue.ok) return resDue;
  if (!resWarn.ok) return resWarn;
  return ok({
    firstResponseDueAt: new Date(firstDue.value),
    firstResponseWarnAt: new Date(firstWarn.value),
    resolutionDueAt: new Date(resDue.value),
    resolutionWarnAt: new Date(resWarn.value),
    paused: false,
  });
};

export type SlaProgress = {
  readonly firstRespondedAt: Date | null;
  readonly resolvedAt: Date | null;
};

/** The deadline the queue sorts by: first response until it is given, then resolution. Null = nothing pending. */
export const nextDueAt = (d: SlaDeadlines, p: SlaProgress): Date | null => {
  if (p.resolvedAt !== null && p.firstRespondedAt !== null) return null;
  if (p.firstRespondedAt === null) return d.firstResponseDueAt;
  return d.resolutionDueAt;
};

/** Milliseconds remaining until `due`, negative when overdue. `nowMs` must come from the (server) clock. */
export const remainingMs = (due: Date, nowMs: number): number => due.getTime() - nowMs;

export type SlaTargetKind = 'first_response' | 'resolution';

/** Which SLA events (warning, breach) are due by `now` and were not yet fired. */
export const dueSlaEvents = (
  d: SlaDeadlines,
  p: SlaProgress,
  fired: ReadonlySet<string>,
  now: Date,
): readonly {
  readonly target: SlaTargetKind;
  readonly event: 'warning' | 'breach';
  readonly at: Date;
}[] => {
  const out: { target: SlaTargetKind; event: 'warning' | 'breach'; at: Date }[] = [];
  const consider = (target: SlaTargetKind, warn: Date | null, due: Date | null): void => {
    if (warn !== null && warn <= now && !fired.has(`${target}:warning`))
      out.push({ target, event: 'warning', at: warn });
    if (due !== null && due <= now && !fired.has(`${target}:breach`))
      out.push({ target, event: 'breach', at: due });
  };
  if (p.firstRespondedAt === null)
    consider('first_response', d.firstResponseWarnAt, d.firstResponseDueAt);
  if (p.resolvedAt === null) consider('resolution', d.resolutionWarnAt, d.resolutionDueAt);
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
};
