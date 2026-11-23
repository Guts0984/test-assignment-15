import type { HoursCalendar } from './business-time';

/** Mon-Fri 09:00-18:00 in the given zone, with optional holidays. */
export const officeCalendar = (
  timeZone: string,
  holidays: readonly string[] = [],
): HoursCalendar => ({
  kind: 'hours',
  timeZone,
  workdays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  holidays,
});

export const HOUR = 3_600_000;
export const utc = (iso: string): number => Date.parse(iso);
