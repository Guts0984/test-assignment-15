import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addBusinessMs,
  ALWAYS,
  businessMsBetween,
  isWithinBusinessHours,
  type HoursCalendar,
} from './business-time';

const zones = ['Europe/Kyiv', 'Europe/Warsaw', 'UTC', 'America/New_York', 'Asia/Kolkata'] as const;

const calendarArb: fc.Arbitrary<HoursCalendar> = fc
  .record({
    timeZone: fc.constantFrom(...zones),
    workdays: fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }),
    startMinute: fc.integer({ min: 0, max: 20 * 60 }),
    length: fc.integer({ min: 30, max: 14 * 60 }),
    holidays: fc.uniqueArray(
      fc
        .integer({ min: 0, max: 400 })
        .map((d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10)),
      { maxLength: 30 },
    ),
  })
  .map(({ length, startMinute, ...rest }) => ({
    kind: 'hours' as const,
    ...rest,
    startMinute,
    endMinute: Math.min(1440, startMinute + length),
  }));

// 2026-01-01 .. 2027-03-01 covers both DST transitions of both zones
const instantArb = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 2, 1) });
const durationArb = fc.integer({ min: 1, max: 120 * 3_600_000 });
const run = { numRuns: 150 };

const must = (r: ReturnType<typeof addBusinessMs>): number => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('business time properties', () => {
  it('business time between start and add(start, d) is exactly d', () => {
    fc.assert(
      fc.property(calendarArb, instantArb, durationArb, (cal, t, d) => {
        const end = must(addBusinessMs(cal, t, d));
        expect(businessMsBetween(cal, t, end)).toBe(d);
      }),
      run,
    );
  });

  it('is monotonic in the duration', () => {
    fc.assert(
      fc.property(calendarArb, instantArb, durationArb, durationArb, (cal, t, a, b) => {
        const [small, large] = a <= b ? [a, b] : [b, a];
        expect(must(addBusinessMs(cal, t, small))).toBeLessThanOrEqual(
          must(addBusinessMs(cal, t, large)),
        );
      }),
      run,
    );
  });

  it('is additive: add(add(t, a), b) === add(t, a + b)', () => {
    fc.assert(
      fc.property(calendarArb, instantArb, durationArb, durationArb, (cal, t, a, b) => {
        const stepwise = must(addBusinessMs(cal, must(addBusinessMs(cal, t, a)), b));
        expect(stepwise).toBe(must(addBusinessMs(cal, t, a + b)));
      }),
      run,
    );
  });

  it('a positive duration always ends inside a working window (closing instant inclusive)', () => {
    fc.assert(
      fc.property(calendarArb, instantArb, durationArb, (cal, t, d) => {
        expect(isWithinBusinessHours(cal, must(addBusinessMs(cal, t, d)))).toBe(true);
      }),
      run,
    );
  });

  it('never ends before it started', () => {
    fc.assert(
      fc.property(calendarArb, instantArb, durationArb, (cal, t, d) => {
        expect(must(addBusinessMs(cal, t, d))).toBeGreaterThan(t);
      }),
      run,
    );
  });

  it('with the 24/7 calendar it is plain addition', () => {
    fc.assert(
      fc.property(instantArb, durationArb, (t, d) => {
        expect(must(addBusinessMs(ALWAYS, t, d))).toBe(t + d);
        expect(businessMsBetween(ALWAYS, t, t + d)).toBe(d);
      }),
      run,
    );
  });

  it('business time never exceeds wall time and is additive over a split point', () => {
    fc.assert(
      fc.property(calendarArb, instantArb, durationArb, durationArb, (cal, t, a, b) => {
        const m = t + a;
        const e = m + b;
        expect(businessMsBetween(cal, t, e)).toBeLessThanOrEqual(e - t);
        expect(businessMsBetween(cal, t, m) + businessMsBetween(cal, m, e)).toBe(
          businessMsBetween(cal, t, e),
        );
      }),
      run,
    );
  });
});
