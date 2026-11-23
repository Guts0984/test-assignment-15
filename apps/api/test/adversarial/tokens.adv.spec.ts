import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from '../attacker/client';
import { createUserRow, login, startApi, testDb, type RunningApi } from '../helpers/api';

let api: RunningApi;
const db = testDb();
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

const me = (token: string | undefined, scheme = 'Bearer') =>
  client({ baseUrl: api.url }).get('/api/v1/auth/me', {
    headers: token === undefined ? {} : { authorization: `${scheme} ${token}` },
  });
const key = () => new TextEncoder().encode(api.env.JWT_ACCESS_SECRET);
const now = () => Math.floor(Date.now() / 1000);

const forge = (
  claims: Record<string, unknown>,
  opts: {
    secret?: Uint8Array;
    alg?: string;
    exp?: number;
    nbf?: number;
    iat?: number;
    iss?: string | null;
    aud?: string | null;
  } = {},
) => {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'HS256' });
  if (opts.iss !== null) jwt = jwt.setIssuer(opts.iss ?? 'helpdesk');
  if (opts.aud !== null) jwt = jwt.setAudience(opts.aud ?? 'helpdesk-api');
  return jwt
    .setIssuedAt(opts.iat ?? now())
    .setNotBefore(opts.nbf ?? now())
    .setExpirationTime(opts.exp ?? now() + 600)
    .sign(opts.secret ?? key());
};

describe('access token attacks', () => {
  it('accepts a genuine token (control)', async () => {
    const u = await createUserRow(db);
    const s = await login(api, u);
    expect((await me(s.accessToken)).status).toBe(200);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const u = await createUserRow(db);
    const t = await forge(
      { sub: u.id, ver: 0, role: 'staff' },
      { secret: new TextEncoder().encode('x'.repeat(40)) },
    );
    expect((await me(t)).status).toBe(401);
  });

  it('rejects a tampered payload (privilege escalation to admin) with the original signature', async () => {
    const u = await createUserRow(db);
    const s = await login(api, u);
    const [h, , sig] = s.accessToken.split('.');
    const payload = Buffer.from(
      JSON.stringify({
        sub: u.id,
        ver: 0,
        role: 'admin',
        iss: 'helpdesk',
        aud: 'helpdesk-api',
        exp: now() + 600,
        iat: now(),
        nbf: now(),
      }),
    ).toString('base64url');
    expect((await me(`${h}.${payload}.${sig}`)).status).toBe(401);
  });

  it('rejects alg:none, other algorithms and an empty signature', async () => {
    const u = await createUserRow(db);
    const body = Buffer.from(
      JSON.stringify({
        sub: u.id,
        ver: 0,
        role: 'staff',
        iss: 'helpdesk',
        aud: 'helpdesk-api',
        exp: now() + 600,
        iat: now(),
        nbf: now(),
      }),
    ).toString('base64url');
    for (const alg of ['none', 'None', 'NONE', 'HS512', 'RS256']) {
      const head = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
      expect((await me(`${head}.${body}.`)).status, alg).toBe(401);
      expect((await me(`${head}.${body}.AAAA`)).status, alg).toBe(401);
    }
    expect(
      (await me(await forge({ sub: u.id, ver: 0, role: 'staff' }, { alg: 'HS512' }))).status,
    ).toBe(401);
  });

  it('rejects expired, not-yet-valid and claim-less tokens', async () => {
    const u = await createUserRow(db);
    expect(
      (
        await me(
          await forge(
            { sub: u.id, ver: 0, role: 'staff' },
            { exp: now() - 10, iat: now() - 700, nbf: now() - 700 },
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await me(
          await forge(
            { sub: u.id, ver: 0, role: 'staff' },
            { nbf: now() + 3600, exp: now() + 7200 },
          ),
        )
      ).status,
    ).toBe(401);
    expect((await me(await forge({ ver: 0, role: 'staff' }))).status).toBe(401); // no sub
    expect((await me(await forge({ sub: u.id, role: 'staff' }))).status).toBe(401); // no ver
    expect((await me(await forge({ sub: u.id, ver: 0 }))).status).toBe(401); // no role
    expect((await me(await forge({ sub: u.id, ver: 0, role: 'root' }))).status).toBe(401);
  });

  it('rejects a wrong issuer or audience', async () => {
    const u = await createUserRow(db);
    expect(
      (await me(await forge({ sub: u.id, ver: 0, role: 'staff' }, { iss: 'evil' }))).status,
    ).toBe(401);
    expect(
      (await me(await forge({ sub: u.id, ver: 0, role: 'staff' }, { aud: 'other-api' }))).status,
    ).toBe(401);
    expect(
      (await me(await forge({ sub: u.id, ver: 0, role: 'staff' }, { iss: null }))).status,
    ).toBe(401);
  });

  it('rejects a valid-looking token for a user that does not exist, and one with a stale version', async () => {
    expect(
      (
        await me(
          await forge({ sub: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ver: 0, role: 'staff' }),
        )
      ).status,
    ).toBe(401);
    const u = await createUserRow(db);
    expect((await me(await forge({ sub: u.id, ver: 99, role: 'staff' }))).status).toBe(401);
  });

  it('a staff token cannot claim to be admin by role claim alone: the database role decides', async () => {
    const u = await createUserRow(db);
    const t = await forge({ sub: u.id, ver: 0, role: 'admin' });
    const r = await client({ baseUrl: api.url }).get('/api/v1/admin/teams', {
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.status).toBe(403);
  });

  it('rejects malformed Authorization headers', async () => {
    for (const h of [
      '',
      'Bearer',
      'Bearer ',
      'Basic abc',
      'bearer abc.def.ghi',
      'Bearer a b',
      `Bearer ${'a'.repeat(10_000)}`,
    ]) {
      const r = await client({ baseUrl: api.url }).get('/api/v1/auth/me', {
        headers: { authorization: h },
      });
      expect(r.status, h.slice(0, 20)).toBe(401);
      expect((r.json as { error: { code: string } }).error.code).toMatch(
        /UNAUTHORIZED|TOKEN_EXPIRED/,
      );
    }
  });
});
