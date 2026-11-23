import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import {
  createUserRow,
  login,
  setTestClock,
  startApi,
  testDb,
  type RunningApi,
} from './helpers/api';

// Serial suite: moves the clock shared by every process, so nothing else may run at the same time.
let a: RunningApi;
let b: RunningApi;
const db = testDb();
beforeAll(async () => {
  [a, b] = [
    await startApi({ API_INSTANCE_ID: 'api-1' }),
    await startApi({ API_INSTANCE_ID: 'api-2' }),
  ];
});
afterAll(async () => {
  await setTestClock(a, { offsetMs: 0 });
  await Promise.all([a.close(), b.close()]);
});

const serverNow = async (api: RunningApi): Promise<number> =>
  Date.parse(
    ((await client({ baseUrl: api.url }).get('/api/v1/time')).json as { now: string }).now,
  );

const waitFor = async (fn: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};

describe('shared test clock', () => {
  it('moves both api copies together and returns to real time', async () => {
    const day = 86_400_000;
    await setTestClock(a, { advanceMs: 3 * day });
    await waitFor(async () => Math.abs((await serverNow(b)) - (Date.now() + 3 * day)) < 5000);
    expect(Math.abs((await serverNow(a)) - (Date.now() + 3 * day))).toBeLessThan(5000);
    await setTestClock(b, { offsetMs: 0 });
    await waitFor(async () => Math.abs((await serverNow(a)) - Date.now()) < 5000);
  });

  it('exposes the server clock in X-Server-Time on every response', async () => {
    const r = await client({ baseUrl: a.url }).get('/api/v1/time');
    expect(Math.abs(Date.parse(String(r.headers['x-server-time'])) - Date.now())).toBeLessThan(
      5000,
    );
    expect(r.headers['x-api-instance']).toBe('api-1');
  });

  it('expires access tokens by the injected server clock', async () => {
    const u = await createUserRow(db);
    const s = await login(a, u);
    expect((await s.client.get('/api/v1/auth/me')).status).toBe(200);
    await setTestClock(a, { advanceMs: (a.env.JWT_ACCESS_TTL_SECONDS + 5) * 1000 });
    const r = await s.client.get('/api/v1/auth/me');
    expect(r.status).toBe(401);
    expect((r.json as { error: { code: string } }).error.code).toBe('TOKEN_EXPIRED');
    await setTestClock(a, { offsetMs: 0 });
    expect((await s.client.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('refuses clock changes without the control token and rejects bad bodies', async () => {
    const c = client({ baseUrl: a.url });
    expect((await c.post('/api/v1/test/clock', { advanceMs: 1000 })).status).toBe(403);
    expect(
      (
        await c.post(
          '/api/v1/test/clock',
          { advanceMs: 1000 },
          { headers: { 'x-test-control-token': 'nope' } },
        )
      ).status,
    ).toBe(403);
    const bad = await c.post(
      '/api/v1/test/clock',
      { advanceMs: 1, offsetMs: 1 },
      { headers: { 'x-test-control-token': a.env.TEST_CONTROL_TOKEN ?? '' } },
    );
    expect(bad.status).toBe(400);
  });
});
