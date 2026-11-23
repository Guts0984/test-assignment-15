import { describe, expect, it } from 'vitest';
import {
  addBusinessMs,
  ALWAYS,
  businessDayMs,
  businessMsBetween,
  isWithinBusinessHours,
  validateCalendar,
  type HoursCalendar,
} from './business-time';
import { HOUR, officeCalendar, utc } from './fixtures';

const kyiv = officeCalendar('Europe/Kyiv');
const iso = (ms: number): string => new Date(ms).toISOString();
const add = (cal: HoursCalendar, start: string, ms: number): string => {
  const r = addBusinessMs(cal, utc(start), ms);
  if (!r.ok) throw new Error(r.error);
  return iso(r.value);
};

describe('addBusinessMs', () => {
  it('stays inside a working day', () => {
    // Wednesday 2026-01-14 10:00 Kyiv (+2) = 08:00Z; +3h = 13:00 Kyiv = 11:00Z
    expect(add(kyiv, '2026-01-14T08:00:00Z', 3 * HOUR)).toBe('2026-01-14T11:00:00.000Z');
  });

  it('returns the window end when the duration ends exactly at closing time', () => {
    // 15:00 Kyiv + 3h = 18:00 Kyiv = 16:00Z, not the next morning
    expect(add(kyiv, '2026-01-14T13:00:00Z', 3 * HOUR)).toBe('2026-01-14T16:00:00.000Z');
  });

  it('rolls over to the next day after closing', () => {
    // 17:00 Kyiv + 2h -> 1h today, 1h tomorrow -> 10:00 Kyiv Thu = 08:00Z
    expect(add(kyiv, '2026-01-14T15:00:00Z', 2 * HOUR)).toBe('2026-01-15T08:00:00.000Z');
  });

  it('starts counting at opening time when created before opening', () => {
    // 06:00 Kyiv (04:00Z) + 1h -> 10:00 Kyiv = 08:00Z
    expect(add(kyiv, '2026-01-14T04:00:00Z', HOUR)).toBe('2026-01-14T08:00:00.000Z');
  });

  it('skips weekends (ACC-3 shape: Friday 16:00 + 4h lands on Monday 11:00)', () => {
    // Friday 2026-01-16 16:00 Kyiv = 14:00Z
    expect(add(kyiv, '2026-01-16T14:00:00Z', 4 * HOUR)).toBe('2026-01-19T09:00:00.000Z');
  });

  it('skips a holiday', () => {
    const cal = officeCalendar('Europe/Kyiv', ['2026-01-15']);
    // Wed 17:00 Kyiv + 2h: 1h Wed, Thu is a holiday, 1h Fri -> Fri 10:00 Kyiv = 08:00Z
    expect(add(cal, '2026-01-14T15:00:00Z', 2 * HOUR)).toBe('2026-01-16T08:00:00.000Z');
  });

  it('returns the start for a zero duration', () => {
    expect(add(kyiv, '2026-01-17T10:00:00Z', 0)).toBe('2026-01-17T10:00:00.000Z');
  });

  it('is 24/7 for the always calendar', () => {
    const r = addBusinessMs(ALWAYS, utc('2026-01-17T10:00:00Z'), 5 * HOUR);
    expect(r).toEqual({ ok: true, value: utc('2026-01-17T15:00:00Z') });
  });

  it('fails instead of looping forever when the needed business time never arrives', () => {
    const oneMinuteMondays: HoursCalendar = {
      ...kyiv,
      workdays: [1],
      startMinute: 600,
      endMinute: 601,
    };
    const r = addBusinessMs(oneMinuteMondays, utc('2026-01-01T00:00:00Z'), 100_000 * HOUR);
    expect(r).toEqual({ ok: false, error: 'NO_BUSINESS_TIME' });
  });

  it('rejects negative and non-finite durations', () => {
    expect(addBusinessMs(kyiv, 0, -1).ok).toBe(false);
    expect(addBusinessMs(kyiv, 0, Number.NaN).ok).toBe(false);
  });
});

describe('daylight saving time', () => {
  const night: HoursCalendar = {
    kind: 'hours',
    timeZone: 'Europe/Kyiv',
    workdays: [1, 2, 3, 4, 5, 6, 7],
    startMinute: 0,
    endMinute: 360,
    holidays: [],
  };

  it('spring forward: a 00:00-06:00 window is only 5 real hours long (2026-03-29)', () => {
    const start = utc('2026-03-28T22:00:00Z'); // 00:00 EET on Sunday
    const end = utc('2026-03-29T03:00:00Z'); // 06:00 EEST
    expect(businessMsBetween(night, start, end)).toBe(5 * HOUR);
    expect(add(night, '2026-03-28T22:00:00Z', 5 * HOUR)).toBe('2026-03-29T03:00:00.000Z');
  });

  it('fall back: a 00:00-06:00 window is 7 real hours long (2026-10-25)', () => {
    const start = utc('2026-10-24T21:00:00Z'); // 00:00 EEST
    const end = utc('2026-10-25T04:00:00Z'); // 06:00 EET
    expect(businessMsBetween(night, start, end)).toBe(7 * HOUR);
  });

  it('a window starting inside the spring-forward gap starts at the first valid instant', () => {
    const gap: HoursCalendar = { ...night, startMinute: 3 * 60 + 30, endMinute: 5 * 60 };
    // 03:30 does not exist on 2026-03-29; the window becomes 04:30-05:00 EEST = 30 minutes
    const from = utc('2026-03-28T22:00:00Z');
    const to = utc('2026-03-29T03:00:00Z');
    expect(businessMsBetween(gap, from, to)).toBe(30 * 60_000);
  });

  it('a normal office day is unaffected by the DST night itself', () => {
    // Friday 2026-03-27 16:00 EET (14:00Z) + 4h -> Monday 2026-03-30 11:00 EEST (08:00Z)
    expect(add(kyiv, '2026-03-27T14:00:00Z', 4 * HOUR)).toBe('2026-03-30T08:00:00.000Z');
  });

  it('Warsaw uses its own zone: 09:00 Warsaw is 08:00Z in winter and 07:00Z in summer', () => {
    const waw = officeCalendar('Europe/Warsaw');
    expect(add(waw, '2026-01-14T07:00:00Z', HOUR)).toBe('2026-01-14T09:00:00.000Z');
    expect(add(waw, '2026-07-14T06:00:00Z', HOUR)).toBe('2026-07-14T08:00:00.000Z');
  });
});

describe('businessMsBetween / helpers', () => {
  it('counts only the overlap with working windows', () => {
    // Fri 17:00 Kyiv -> Mon 10:00 Kyiv = 1h + 1h
    expect(businessMsBetween(kyiv, utc('2026-01-16T15:00:00Z'), utc('2026-01-19T08:00:00Z'))).toBe(
      2 * HOUR,
    );
  });

  it('returns 0 when the range is empty or reversed', () => {
    expect(businessMsBetween(kyiv, 100, 100)).toBe(0);
    expect(businessMsBetween(kyiv, 200, 100)).toBe(0);
  });

  it('isWithinBusinessHours includes the closing instant and excludes holidays', () => {
    expect(isWithinBusinessHours(kyiv, utc('2026-01-14T16:00:00Z'))).toBe(true); // 18:00 Kyiv
    expect(isWithinBusinessHours(kyiv, utc('2026-01-14T16:00:01Z'))).toBe(false);
    expect(
      isWithinBusinessHours(
        officeCalendar('Europe/Kyiv', ['2026-01-14']),
        utc('2026-01-14T10:00:00Z'),
      ),
    ).toBe(false);
  });

  it('a business day equals the daily window length', () => {
    expect(businessDayMs(kyiv)).toBe(9 * HOUR);
    expect(businessDayMs(ALWAYS)).toBe(24 * HOUR);
  });

  it('validates calendars', () => {
    expect(validateCalendar(kyiv).ok).toBe(true);
    expect(validateCalendar({ ...kyiv, timeZone: 'Mars/Olympus' }).ok).toBe(false);
    expect(validateCalendar({ ...kyiv, workdays: [] }).ok).toBe(false);
    expect(validateCalendar({ ...kyiv, startMinute: 600, endMinute: 600 }).ok).toBe(false);
    expect(validateCalendar({ ...kyiv, endMinute: 1441 }).ok).toBe(false);
    expect(validateCalendar({ ...kyiv, workdays: [0] }).ok).toBe(false);
  });
});
