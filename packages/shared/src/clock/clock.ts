/** All time in the system comes from an injected Clock so tests can control it. */
export type Clock = { readonly now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at a given instant; `set` and `advance` return a new instant via the returned controller. */
export type ManualClock = Clock & {
  readonly set: (to: Date) => void;
  readonly advanceMs: (ms: number) => void;
};

export const createManualClock = (start: Date): ManualClock => {
  const state = { current: start.getTime() };
  return {
    now: () => new Date(state.current),
    set: (to) => {
      state.current = to.getTime();
    },
    advanceMs: (ms) => {
      state.current += ms;
    },
  };
};

/** Clock that adds a mutable offset (milliseconds) to a base clock. Used by the shared test clock. */
export type OffsetClock = Clock & {
  readonly setOffsetMs: (ms: number) => void;
  readonly getOffsetMs: () => number;
};

export const createOffsetClock = (base: Clock, initialOffsetMs = 0): OffsetClock => {
  const state = { offset: initialOffsetMs };
  return {
    now: () => new Date(base.now().getTime() + state.offset),
    setOffsetMs: (ms) => {
      state.offset = ms;
    },
    getOffsetMs: () => state.offset,
  };
};
