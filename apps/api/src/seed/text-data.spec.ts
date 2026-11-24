import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { buildBodyPool, buildSubjectPool } from './text-data';

describe('seed text', () => {
  const bodies = buildBodyPool(createRng(42), 500);
  const subjects = buildSubjectPool(createRng(42), 300);

  it('reads like customer messages: real words, whole sentences, no word fragments', () => {
    for (const b of bodies.slice(0, 100)) {
      expect(b).toMatch(/^(Hello,|Hi team,|Good day,|Dear support,|Hi,) [A-Z]/);
      expect(b).toMatch(/[.?]$/);
      // the old generator produced stubs such as "paymx7919" (a word cut to four letters plus a number)
      expect(b).not.toMatch(/[a-z]{3,}x\d{3,}/);
      for (const word of b.split(/\s+/)) expect(word).toMatch(/^[A-Za-z0-9.,?'-]+$/);
    }
    for (const s of subjects) {
      expect(s).toMatch(/^[A-Z]/);
      expect(s).not.toMatch(/[a-z]{3,}x\d{3,}/);
    }
  });

  it('is deterministic for a seed and varied across messages', () => {
    expect(buildBodyPool(createRng(42), 50)).toEqual(buildBodyPool(createRng(42), 50));
    expect(new Set(bodies).size).toBeGreaterThan(450);
    expect(new Set(subjects).size).toBeGreaterThan(60);
  });

  it('has plenty of words that appear in 0.1 to 1 percent of the messages (the search budget test needs them)', () => {
    const n = 5000;
    const pool = buildBodyPool(createRng(42), n);
    const df = new Map<string, number>();
    for (const b of pool)
      for (const w of new Set(b.toLowerCase().match(/[a-z]+/g) ?? []))
        df.set(w, (df.get(w) ?? 0) + 1);
    const band = [...df].filter(([, c]) => c / n >= 0.001 && c / n <= 0.01);
    expect(band.length).toBeGreaterThan(50);
  });

  it('keeps the words the tests and the search budget depend on, with a spread of frequencies', () => {
    const share = (w: string): number =>
      bodies.filter((b) => b.toLowerCase().includes(w)).length / bodies.length;
    for (const w of ['payment', 'invoice', 'refund', 'order'])
      expect(share(w), w).toBeGreaterThan(0);
    expect(share('account')).toBeGreaterThan(share('activation key')); // a skewed, not uniform, distribution
  });
});
