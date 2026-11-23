import { describe, expect, it } from 'vitest';
import { createManualClock, createOffsetClock, systemClock } from './clock';

describe('clock', () => {
  it('manual clock is frozen until moved', () => {
    const c = createManualClock(new Date('2025-01-01T00:00:00Z'));
    expect(c.now().toISOString()).toBe('2025-01-01T00:00:00.000Z');
    c.advanceMs(9_900);
    expect(c.now().toISOString()).toBe('2025-01-01T00:00:09.900Z');
    c.set(new Date('2026-06-01T12:00:00Z'));
    expect(c.now().toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('manual clock returns independent Date instances', () => {
    const c = createManualClock(new Date(0));
    c.now().setFullYear(2000);
    expect(c.now().getTime()).toBe(0);
  });

  it('offset clock shifts the base clock and can be reset', () => {
    const base = createManualClock(new Date('2025-01-01T00:00:00Z'));
    const c = createOffsetClock(base);
    c.setOffsetMs(3 * 24 * 3600_000);
    expect(c.now().toISOString()).toBe('2025-01-04T00:00:00.000Z');
    c.setOffsetMs(0);
    expect(c.now().toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('system clock is close to real time', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
