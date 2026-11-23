import { describe, expect, it } from 'vitest';
import { createBudget } from './budget';

describe('socket event budget', () => {
  it('allows the budget per second, drops the excess, and recovers in the next second', () => {
    const b = createBudget(5);
    const first = Array.from({ length: 8 }, () => b.take(10_000));
    expect(first).toEqual([true, true, true, true, true, false, false, false]);
    expect(b.take(10_999)).toBe(false);
    expect(b.take(11_000)).toBe(true);
  });

  it('is per connection: one flooding budget does not affect another', () => {
    const [a, c] = [createBudget(2), createBudget(2)];
    for (let i = 0; i < 100; i += 1) a.take(1);
    expect(c.take(1)).toBe(true);
  });
});
