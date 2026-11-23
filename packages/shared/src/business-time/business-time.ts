import { DateTime } from 'luxon';
import { err, ok, type Result } from '../result/result';

/**
 * A team's working calendar. Window bounds are LOCAL wall-clock minutes in `timeZone`,
 * so daylight-saving shifts are handled by resolving each date separately.
 */
export type HoursCalendar = {
  readonly kind: 'hours';
  readonly timeZone: string;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  readonly workdays: readonly number[];
  /** Minutes after local midnight, 0..1439. */
  readonly startMinute: number;
  /** Minutes after local midnight, 1..1440 (1440 = end of day). Must be greater than startMinute. */
  readonly endMinute: number;
  /** Local dates (YYYY-MM-DD) on which the team is closed for the whole day. */
  readonly holidays: readonly string[];
};

export type AlwaysCalendar = { readonly kind: 'always' };
export type BusinessCalendar = HoursCalendar | AlwaysCalendar;

export const ALWAYS: AlwaysCalendar = { kind: 'always' };

export type BusinessTimeError = 'NO_BUSINESS_TIME' | 'INVALID_CALENDAR';

/** Longest search for working time (about 10 years of days) before giving up. */
const MAX_DAYS_SCANNED = 3660;

export const validateCalendar = (
  cal: BusinessCalendar,
): Result<BusinessCalendar, BusinessTimeError> => {
  if (cal.kind === 'always') return ok(cal);
  if (!DateTime.local().setZone(cal.timeZone).isValid) return err('INVALID_CALENDAR');
  const daysOk =
    cal.workdays.length > 0 && cal.workdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  const minutesOk =
    Number.isInteger(cal.startMinute) &&
    Number.isInteger(cal.endMinute) &&
    cal.startMinute >= 0 &&
    cal.endMinute <= 1440 &&
    cal.endMinute > cal.startMinute;
  return daysOk && minutesOk ? ok(cal) : err('INVALID_CALENDAR');
};

/** Length of one business day in milliseconds (the nominal length of the daily window). */
export const businessDayMs = (cal: BusinessCalendar): number =>
  cal.kind === 'always' ? 24 * 3_600_000 : (cal.endMinute - cal.startMinute) * 60_000;

type DayWindow = { readonly startMs: number; readonly endMs: number };

const instantAt = (day: DateTime, minute: number): number => {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf('day').toMillis();
  // A local time inside a DST gap is moved forward by luxon to the first valid instant.
  return day
    .set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 })
    .toMillis();
};

const windowOf = (cal: HoursCalendar, day: DateTime): DayWindow | null => {
  const iso = day.toISODate();
  if (iso === null || !cal.workdays.includes(day.weekday) || cal.holidays.includes(iso))
    return null;
  const startMs = instantAt(day, cal.startMinute);
  const endMs = instantAt(day, cal.endMinute);
  return endMs > startMs ? { startMs, endMs } : null;
};

const dayOf = (cal: HoursCalendar, ms: number): DateTime =>
  DateTime.fromMillis(ms, { zone: cal.timeZone }).startOf('day');

/**
 * The instant at which `durationMs` of business time has elapsed since `startMs`.
 * Business time that ends exactly at the window end returns that end instant.
 */
export const addBusinessMs = (
  cal: BusinessCalendar,
  startMs: number,
  durationMs: number,
): Result<number, BusinessTimeError> => {
  if (durationMs < 0 || !Number.isFinite(durationMs)) return err('INVALID_CALENDAR');
  const duration = Math.round(durationMs);
  if (cal.kind === 'always') return ok(startMs + duration);
  if (duration === 0) return ok(startMs);
  let remaining = duration;
  let day = dayOf(cal, startMs);
  for (let i = 0; i < MAX_DAYS_SCANNED; i += 1) {
    const w = windowOf(cal, day);
    if (w !== null) {
      const from = Math.max(w.startMs, startMs);
      if (from < w.endMs) {
        const available = w.endMs - from;
        if (remaining <= available) return ok(from + remaining);
        remaining -= available;
      }
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  return err('NO_BUSINESS_TIME');
};

/** Business time in milliseconds between two instants (0 if `toMs <= fromMs`). */
export const businessMsBetween = (cal: BusinessCalendar, fromMs: number, toMs: number): number => {
  if (toMs <= fromMs) return 0;
  if (cal.kind === 'always') return toMs - fromMs;
  let total = 0;
  let day = dayOf(cal, fromMs);
  const lastDay = dayOf(cal, toMs).toMillis();
  for (let i = 0; i < MAX_DAYS_SCANNED && day.toMillis() <= lastDay; i += 1) {
    const w = windowOf(cal, day);
    if (w !== null) {
      const lo = Math.max(w.startMs, fromMs);
      const hi = Math.min(w.endMs, toMs);
      if (hi > lo) total += hi - lo;
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  return total;
};

/** True if `ms` lies inside a working window (end instant inclusive). */
export const isWithinBusinessHours = (cal: BusinessCalendar, ms: number): boolean => {
  if (cal.kind === 'always') return true;
  const w = windowOf(cal, dayOf(cal, ms));
  return w !== null && ms >= w.startMs && ms <= w.endMs;
};

/** Local calendar date (YYYY-MM-DD) of an instant in the calendar's zone; UTC date for 24/7. */
export const localDateOf = (cal: BusinessCalendar, ms: number): string => {
  const zone = cal.kind === 'always' ? 'utc' : cal.timeZone;
  return DateTime.fromMillis(ms, { zone }).toISODate() ?? '';
};
