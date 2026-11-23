/** Deterministic randomness (mulberry32) so chaos runs are reproducible from MAIL_CHAOS_SEED. */
const mulberry32 = (seed: number): (() => number) => {
  const state = { a: seed >>> 0 };
  return () => {
    state.a = (state.a + 0x6d2b79f5) >>> 0;
    let t = state.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export type ChaosSettings = {
  readonly enabled: boolean;
  readonly seed: number;
  /** Every Nth outbound SMTP transaction gets a temporary error. */
  readonly failEvery: number;
  /** Share of successfully delivered outbound mails answered by an autoreply or a bounce. */
  readonly autoreplyRate: number;
};

export type AutoResponse = 'autoreply' | 'bounce';

export type Chaos = {
  readonly settings: () => ChaosSettings;
  readonly setEnabled: (on: boolean) => void;
  /** Counts one SMTP transaction; true when it must fail with a 4xx. */
  readonly shouldFailTransaction: () => boolean;
  /** True when an inbound delivery must be sent twice. */
  readonly shouldDuplicateInbound: () => boolean;
  /** What (if anything) answers a delivered outbound mail. */
  readonly autoResponseFor: () => AutoResponse | null;
  readonly reset: () => void;
};

export const createChaos = (initial: ChaosSettings): Chaos => {
  const state = {
    enabled: initial.enabled,
    count: 0,
    rand: mulberry32(initial.seed),
    alternate: 0,
  };
  return {
    settings: () => ({ ...initial, enabled: state.enabled }),
    setEnabled: (on) => {
      state.enabled = on;
    },
    shouldFailTransaction: () => {
      state.count += 1;
      return state.enabled && initial.failEvery > 0 && state.count % initial.failEvery === 0;
    },
    shouldDuplicateInbound: () => state.enabled,
    autoResponseFor: () => {
      if (!state.enabled || state.rand() >= initial.autoreplyRate) return null;
      state.alternate += 1;
      return state.alternate % 2 === 1 ? 'autoreply' : 'bounce';
    },
    reset: () => {
      state.count = 0;
      state.rand = mulberry32(initial.seed);
      state.alternate = 0;
    },
  };
};
