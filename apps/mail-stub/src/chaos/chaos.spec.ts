import { describe, expect, it } from 'vitest';
import { createChaos } from './chaos';

const settings = { enabled: true, seed: 7, failEvery: 10, autoreplyRate: 0.5 };

describe('chaos', () => {
  it('fails exactly every 10th transaction (10, 20, 30...) and none when disabled', () => {
    const c = createChaos(settings);
    const failed = Array.from({ length: 35 }, (_, i) =>
      c.shouldFailTransaction() ? i + 1 : 0,
    ).filter((n) => n > 0);
    expect(failed).toEqual([10, 20, 30]);
    const off = createChaos({ ...settings, enabled: false });
    expect(Array.from({ length: 50 }, () => off.shouldFailTransaction()).some(Boolean)).toBe(false);
  });

  it('is deterministic for a seed and reproducible after reset', () => {
    const run = (c: ReturnType<typeof createChaos>) =>
      Array.from({ length: 40 }, () => c.autoResponseFor());
    const a = run(createChaos(settings));
    expect(run(createChaos(settings))).toEqual(a);
    const c = createChaos(settings);
    run(c);
    c.reset();
    expect(run(c)).toEqual(a);
    expect(a.filter((x) => x === 'autoreply').length).toBeGreaterThan(0);
    expect(a.filter((x) => x === 'bounce').length).toBeGreaterThan(0);
  });

  it('duplicates inbound only while enabled and can be toggled at runtime', () => {
    const c = createChaos({ ...settings, enabled: false });
    expect(c.shouldDuplicateInbound()).toBe(false);
    c.setEnabled(true);
    expect(c.shouldDuplicateInbound()).toBe(true);
    expect(c.settings().enabled).toBe(true);
  });
});
