import { describe, expect, it } from 'vitest';
import { clockStore, formatRemaining, remainingMs, skewFrom, urgencyOf } from './server-clock';

describe('server clock', () => {
  it('derives the skew from a server timestamp and ignores garbage', () => {
    expect(skewFrom('2026-03-01T10:00:05.000Z', Date.parse('2026-03-01T10:00:00.000Z'))).toBe(5000);
    expect(skewFrom('nonsense', 0)).toBeNull();
  });

  it('computes the remaining time by the server clock even when the browser clock is 2 hours off', () => {
    const due = '2026-03-01T12:00:00.000Z';
    const browserNow = Date.parse('2026-03-01T12:00:00.000Z'); // the browser believes it is already due
    const skew = skewFrom('2026-03-01T10:00:00.000Z', browserNow) ?? 0; // the server says it is 10:00
    expect(remainingMs(due, browserNow, skew)).toBe(2 * 3_600_000);
  });

  it('formats and classifies', () => {
    expect(formatRemaining(2 * 3_600_000 + 5 * 60_000)).toBe('2h 05m');
    expect(formatRemaining(12 * 60_000 + 30_000)).toBe('12m 30s');
    expect(formatRemaining(-4 * 60_000)).toBe('overdue 4m 00s');
    expect(urgencyOf(-1, null)).toBe('overdue');
    expect(urgencyOf(10 * 60_000, 3_600_000)).toBe('critical');
    expect(urgencyOf(30 * 60_000, null)).toBe('warning');
    expect(urgencyOf(5 * 3_600_000, null)).toBe('ok');
  });

  it('notifies subscribers only when the skew changes', () => {
    let calls = 0;
    const off = clockStore.subscribe(() => (calls += 1));
    clockStore.setSkew(1000);
    clockStore.setSkew(1000);
    clockStore.setSkew(-5);
    off();
    clockStore.setSkew(7);
    expect([calls, clockStore.getSkew()]).toEqual([2, 7]);
  });
});
