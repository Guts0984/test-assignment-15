import createClient, { type Middleware } from 'openapi-fetch';
import { clientEnv } from '../config/env.client';
import { clockStore, skewFrom } from '../lib/server-clock';
import type { paths } from './generated/schema';

/** The access token lives in memory only; the refresh cookie (HttpOnly) restores it after a reload. */
const auth = { token: null as string | null, onRefreshFailed: (() => undefined) as () => void };

export const tokenStore = {
  get: (): string | null => auth.token,
  set: (t: string | null): void => {
    auth.token = t;
  },
  onRefreshFailed: (fn: () => void): void => {
    auth.onRefreshFailed = fn;
  },
};

const BASE = '';
let refreshing: Promise<boolean> | null = null;

/** Rotates the refresh cookie and stores the new access token. Concurrent callers share one request. */
export const refreshSession = (): Promise<boolean> => {
  refreshing ??= fetch(`${clientEnv.NEXT_PUBLIC_API_BASE_PATH}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
    .then(async (r) => {
      if (!r.ok) return false;
      const body = (await r.json()) as { accessToken: string };
      auth.token = body.accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
};

const trackServerTime: Middleware = {
  onResponse({ response }) {
    const header = response.headers.get('x-server-time');
    if (header !== null) {
      const skew = skewFrom(header, Date.now());
      if (skew !== null) clockStore.setSkew(skew);
    }
    return response;
  },
};

const withAuth =
  (inner: typeof fetch): typeof fetch =>
  async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const retry = request.clone();
    const attempt = (r: Request): Promise<Response> => {
      if (auth.token !== null) r.headers.set('authorization', `Bearer ${auth.token}`);
      return inner(r);
    };
    const first = await attempt(request);
    if (first.status !== 401 || new URL(request.url, 'http://x').pathname.includes('/auth/'))
      return first;
    if (await refreshSession()) return attempt(retry);
    auth.onRefreshFailed();
    return first;
  };

/** Staff API client (generated types from the OpenAPI document). */
export const api = createClient<paths>({
  baseUrl: BASE,
  fetch: withAuth((r) => fetch(r as Request, { credentials: 'include' })),
});
api.use(trackServerTime);

/** Customer clients: the link token (from the URL fragment) names exactly one ticket or survey. */
export const customerApi = (header: 'X-Ticket-Token' | 'X-Survey-Token', token: string) => {
  const c = createClient<paths>({ baseUrl: BASE, headers: { [header]: token } });
  c.use(trackServerTime);
  return c;
};

export type { paths };
