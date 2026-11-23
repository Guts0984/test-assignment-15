import { describe, expect, it } from 'vitest';
import { createTtlCache } from './ttl-cache';

describe('ttl cache', () => {
  it('serves a fresh entry without recomputing and recomputes after the ttl', async () => {
    let t = 0;
    let calls = 0;
    const c = createTtlCache<number>(1000, () => t);
    const compute = async () => ++calls;
    expect([await c.get('a', compute), await c.get('a', compute)]).toEqual([1, 1]);
    t = 999;
    expect(await c.get('a', compute)).toBe(1);
    t = 1000;
    expect(await c.get('a', compute)).toBe(2);
  });
  it('shares one computation between concurrent identical requests and keeps keys apart', async () => {
    let calls = 0;
    const c = createTtlCache<number>(1000, () => 0);
    const slow = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const results = await Promise.all([c.get('x', slow), c.get('x', slow), c.get('x', slow), c.get('y', slow)]);
    expect(calls).toBe(2);
    expect(results.slice(0, 3)).toEqual([results[0], results[0], results[0]]);
  });
  it('does not cache failures', async () => {
    const c = createTtlCache<number>(1000, () => 0);
    await expect(c.get('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await c.get('k', async () => 7)).toBe(7);
  });
  it('evicts the oldest entry beyond the cap', async () => {
    const c = createTtlCache<number>(1000, () => 0, 2);
    let n = 0;
    for (const k of ['a', 'b', 'c']) await c.get(k, async () => ++n);
    expect(await c.get('a', async () => 99)).toBe(99);
  });
});
