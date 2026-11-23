import { describe, expect, it } from 'vitest';
import { signInbound, verifyInbound } from './signature';

const secret = 'k'.repeat(32);
const body = Buffer.from('From: a@b.test\r\n\r\nhello');
const now = Date.parse('2026-03-01T10:00:00Z');
const t = Math.floor(now / 1000);

describe('inbound signature', () => {
  it('verifies a fresh correct signature', () => {
    expect(verifyInbound(secret, signInbound(secret, t, body), body, now, 300)).toBe('ok');
  });
  it('rejects a changed body, another secret, and a replay outside the tolerance', () => {
    const sig = signInbound(secret, t, body);
    expect(verifyInbound(secret, sig, Buffer.from('x'), now, 300)).toBe('mismatch');
    expect(verifyInbound('z'.repeat(32), sig, body, now, 300)).toBe('mismatch');
    expect(verifyInbound(secret, sig, body, now + 301_000, 300)).toBe('stale');
    expect(verifyInbound(secret, sig, body, now - 301_000, 300)).toBe('stale');
    expect(verifyInbound(secret, sig, body, now + 299_000, 300)).toBe('ok');
  });
  it('rejects malformed headers without throwing', () => {
    for (const h of [
      undefined,
      '',
      't=1',
      `t=${t},v1=zz`,
      `t=${t},v1=${'a'.repeat(63)}`,
      `v1=${'a'.repeat(64)},t=${t}`,
      'garbage',
    ]) {
      expect(verifyInbound(secret, h, body, now, 300)).toBe('malformed');
    }
  });
  it('binds the timestamp into the signature', () => {
    const sig = signInbound(secret, t, body).replace(`t=${t}`, `t=${t + 1}`);
    expect(verifyInbound(secret, sig, body, now, 300)).toBe('mismatch');
  });
});
