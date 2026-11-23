/** Per-connection budget for client->server events (never keyed by IP). */
export type Budget = { readonly take: (nowMs: number) => boolean };

export const createBudget = (perSecond: number): Budget => {
  const state = { windowStart: 0, count: 0 };
  return {
    take: (nowMs) => {
      if (nowMs - state.windowStart >= 1000) {
        state.windowStart = nowMs;
        state.count = 0;
      }
      state.count += 1;
      return state.count <= perSecond;
    },
  };
};
