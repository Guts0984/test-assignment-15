/**
 * The browser clock is never trusted for SLA countdowns. Every API response carries X-Server-Time, from which the
 * skew (server minus browser) is derived; countdowns use `Date.now() + skew`.
 */
export type ClockSkew = { readonly skewMs: number };

export const skewFrom = (serverTimeIso: string, browserNowMs: number): number | null => {
  const server = Date.parse(serverTimeIso);
  return Number.isNaN(server) ? null : server - browserNowMs;
};

export const serverNowMs = (browserNowMs: number, skewMs: number): number => browserNowMs + skewMs;

/** Milliseconds left until `dueIso` by the server clock; negative once overdue. */
export const remainingMs = (dueIso: string, browserNowMs: number, skewMs: number): number =>
  Date.parse(dueIso) - serverNowMs(browserNowMs, skewMs);

export type Urgency = 'overdue' | 'critical' | 'warning' | 'ok';

export const urgencyOf = (remaining: number, totalMs: number | null): Urgency => {
  if (remaining <= 0) return 'overdue';
  if (totalMs !== null && remaining <= totalMs * 0.2) return 'critical';
  if (remaining <= 3_600_000) return 'warning';
  return 'ok';
};

/** "2h 05m", "12m 30s", "overdue 4m". */
export const formatRemaining = (ms: number): string => {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const body =
    h > 0
      ? `${h}h ${String(m).padStart(2, '0')}m`
      : m > 0
        ? `${m}m ${String(s).padStart(2, '0')}s`
        : `${s}s`;
  return ms < 0 ? `overdue ${body}` : body;
};

/** Tiny external store so every countdown on the page shares one skew. */
const state = { skew: 0, listeners: new Set<() => void>() };
export const clockStore = {
  getSkew: (): number => state.skew,
  setSkew: (ms: number): void => {
    if (ms === state.skew) return;
    state.skew = ms;
    for (const l of state.listeners) l();
  },
  subscribe: (l: () => void): (() => void) => {
    state.listeners.add(l);
    return () => state.listeners.delete(l);
  },
};
