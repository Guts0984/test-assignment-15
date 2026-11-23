/** Small deterministic PRNG (mulberry32) so a seed value reproduces the same data. */
export type Rng = {
  readonly next: () => number;
  readonly int: (min: number, max: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly chance: (p: number) => boolean;
  /** Index in [0, n) skewed towards 0 (Zipf-like); `skew` > 1 makes the head heavier. */
  readonly skewed: (n: number, skew: number) => number;
};

export const createRng = (seed: number): Rng => {
  const state = { a: seed >>> 0 };
  const next = (): number => {
    state.a = (state.a + 0x6d2b79f5) >>> 0;
    let t = state.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    chance: (p) => next() < p,
    skewed: (n, skew) => Math.min(n - 1, Math.floor(Math.pow(next(), skew) * n)),
  };
};
