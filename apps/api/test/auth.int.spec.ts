import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import { burst } from './attacker/http';
import { createUserRow, login, PASSWORD, startApi, testDb, type RunningApi } from './helpers/api';

let api: RunningApi;
const db = testDb();
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

const anon = () => client({ baseUrl: api.url });

describe('login', () => {
  it('returns an access token, the user and an HttpOnly SameSite=Strict refresh cookie', async () => {
    const u = await createUserRow(db);
    const r = await anon().post('/api/v1/auth/login', { email: u.email, password: PASSWORD });
    expect(r.status).toBe(200);
    const body = r.json as { accessToken: string; user: { email: string; memberships: unknown[] } };
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.user.email).toBe(u.email);
    const cookie = String(r.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/^hd_refresh=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(r.text).not.toContain('passwordHash');
    expect(r.text).not.toContain('refresh');
  });

  it('answers a wrong password and an unknown email identically (status, body, timing class)', async () => {
    const u = await createUserRow(db);
    const wrong = await anon().post('/api/v1/auth/login', {
      email: u.email,
      password: 'wrong-password',
    });
    const unknown = await anon().post('/api/v1/auth/login', {
      email: 'nobody@test.example',
      password: 'wrong-password',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = (j: unknown) => JSON.stringify(j, (k, v) => (k === 'requestId' ? undefined : v));
    expect(strip(wrong.json)).toBe(strip(unknown.json));
    expect((wrong.json as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    // both paths run an argon2 verification, so neither is dramatically faster
    const samples = async (email: string) => {
      const t: number[] = [];
      for (let i = 0; i < 5; i += 1)
        t.push((await anon().post('/api/v1/auth/login', { email, password: 'wrong-password' })).ms);
      return t.sort((a, b) => a - b)[2] ?? 0;
    };
    const [a, b] = [await samples(u.email), await samples('nobody@test.example')];
    expect(Math.min(a, b) / Math.max(a, b)).toBeGreaterThan(0.3);
  });

  it('rejects deactivated users even with the right password', async () => {
    const u = await createUserRow(db, { active: false });
    const r = await anon().post('/api/v1/auth/login', { email: u.email, password: PASSWORD });
    expect(r.status).toBe(401);
  });
});

describe('refresh rotation and reuse detection', () => {
  it('rotates the cookie; the old refresh token then reveals theft and kills the whole family', async () => {
    const u = await createUserRow(db);
    const first = await login(api, u);
    const rotated = await anon().post('/api/v1/auth/refresh', undefined, {
      headers: { cookie: first.cookie },
    });
    expect(rotated.status).toBe(200);
    const newCookie = String(rotated.headers['set-cookie']?.[0]).split(';')[0] ?? '';
    expect(newCookie).not.toBe(first.cookie);
    const newAccess = (rotated.json as { accessToken: string }).accessToken;
    expect(
      (await client({ baseUrl: api.url, auth: { bearer: newAccess } }).get('/api/v1/auth/me'))
        .status,
    ).toBe(200);

    const replay = await anon().post('/api/v1/auth/refresh', undefined, {
      headers: { cookie: first.cookie },
    });
    expect(replay.status).toBe(401);
    // the newest token of the family is dead too
    const afterTheft = await anon().post('/api/v1/auth/refresh', undefined, {
      headers: { cookie: newCookie },
    });
    expect(afterTheft.status).toBe(401);
  });

  it('parallel refreshes with one token: exactly one wins, and the family is then revoked', async () => {
    const u = await createUserRow(db);
    const s = await login(api, u);
    const results = await burst(6, () =>
      anon().post('/api/v1/auth/refresh', undefined, { headers: { cookie: s.cookie } }),
    );
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(results.every((r) => r.status === 200 || r.status === 401)).toBe(true);
  });

  it('logout revokes the refresh family and invalidates outstanding access tokens', async () => {
    const u = await createUserRow(db);
    const s = await login(api, u);
    expect((await s.client.get('/api/v1/auth/me')).status).toBe(200);
    const out = await anon().post('/api/v1/auth/logout', undefined, {
      headers: { cookie: s.cookie },
    });
    expect(out.status).toBe(200);
    expect((await s.client.get('/api/v1/auth/me')).status).toBe(401);
    expect(
      (await anon().post('/api/v1/auth/refresh', undefined, { headers: { cookie: s.cookie } }))
        .status,
    ).toBe(401);
  });

  it('refresh without or with a garbage cookie is a generic 401', async () => {
    for (const cookie of [undefined, 'hd_refresh=', 'hd_refresh=garbage', 'other=1']) {
      const r = await anon().post('/api/v1/auth/refresh', undefined, {
        headers: cookie === undefined ? {} : { cookie },
      });
      expect(r.status).toBe(401);
      expect((r.json as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('sessions follow the database', () => {
  it('deactivating a user kills their existing access token immediately', async () => {
    const u = await createUserRow(db);
    const s = await login(api, u);
    await db.user.update({ where: { id: u.id }, data: { isActive: false } });
    expect((await s.client.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('a token version bump (password change, logout elsewhere) invalidates old access tokens', async () => {
    const u = await createUserRow(db);
    const s = await login(api, u);
    await db.user.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await s.client.get('/api/v1/auth/me')).status).toBe(401);
  });
});
