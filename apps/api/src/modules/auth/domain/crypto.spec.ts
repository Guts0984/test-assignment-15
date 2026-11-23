import { describe, expect, it } from 'vitest';
import { clearRefreshCookie, readCookie, refreshCookie } from './cookies';
import { hashToken, randomToken, safeEqual } from './crypto';
import { signAccessToken, verifyAccessToken } from './jwt';

const SECRET = 's'.repeat(40);
const now = new Date('2026-03-01T10:00:00Z');

describe('tokens', () => {
  it('generates distinct 43-character url-safe tokens and stores only hashes', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });

  it('compares secrets in constant time and handles unequal lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('access tokens', () => {
  const claims = {
    userId: 'u1',
    version: 3,
    role: 'staff' as const,
    sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  };

  it('round-trips and rejects after expiry using the injected clock', async () => {
    const t = await signAccessToken(SECRET, claims, now, 900);
    expect(await verifyAccessToken(SECRET, t, now)).toEqual({ ok: true, value: claims });
    expect(await verifyAccessToken(SECRET, t, new Date(now.getTime() + 899_000))).toMatchObject({
      ok: true,
    });
    expect(await verifyAccessToken(SECRET, t, new Date(now.getTime() + 901_000))).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('rejects a token that is not valid yet', async () => {
    const t = await signAccessToken(SECRET, claims, now, 900);
    expect(await verifyAccessToken(SECRET, t, new Date(now.getTime() - 60_000))).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('rejects the wrong secret, tampered payloads, alg none and garbage', async () => {
    const t = await signAccessToken(SECRET, claims, now, 900);
    expect((await verifyAccessToken('x'.repeat(40), t, now)).ok).toBe(false);
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', ver: 0, role: 'admin' })).toString(
      'base64url',
    );
    expect((await verifyAccessToken(SECRET, `${h}.${forged}.${s}`, now)).ok).toBe(false);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    expect((await verifyAccessToken(SECRET, none, now)).ok).toBe(false);
    for (const junk of ['', 'a.b', 'a.b.c', '....', 'x'.repeat(5000)]) {
      expect((await verifyAccessToken(SECRET, junk, now)).ok).toBe(false);
    }
  });
});

describe('cookies', () => {
  it('reads a named cookie among several', () => {
    expect(readCookie('a=1; hd_refresh=abc%20d; b=2', 'hd_refresh')).toBe('abc d');
    expect(readCookie('a=1', 'hd_refresh')).toBeNull();
    expect(readCookie(undefined, 'x')).toBeNull();
  });

  it('builds a scoped HttpOnly SameSite=Strict cookie', () => {
    const c = refreshCookie('tok', 60, true);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/api/v1/auth');
    expect(c).toContain('Secure');
    expect(refreshCookie('tok', 60, false)).not.toContain('Secure');
    expect(clearRefreshCookie(false)).toContain('Max-Age=0');
  });
});
