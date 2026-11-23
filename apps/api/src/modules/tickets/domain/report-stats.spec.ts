import { describe, expect, it } from 'vitest';
import { addBucket, emptyBucket, percentileCont, toStats } from './report-stats';

describe('report statistics', () => {
  it('matches SQL percentile_cont on known inputs', () => {
    expect(percentileCont([10, 20, 30, 40, 100], 0.5)).toBe(30);
    expect(percentileCont([10, 20, 30, 40, 100], 0.9)).toBeCloseTo(76, 10);
    expect(percentileCont([5], 0.9)).toBe(5);
    expect(percentileCont([4, 2], 0.5)).toBe(3);
    expect(percentileCont([], 0.5)).toBeNull();
  });
  it('does not mutate its input and handles unsorted values', () => {
    const v = [3, 1, 2];
    expect(percentileCont(v, 0.5)).toBe(2);
    expect(v).toEqual([3, 1, 2]);
  });
  it('merges buckets and computes shares and averages with rounding', () => {
    const a = { ...emptyBucket(), tickets: 3, fr: [10, 20], decided: 3, within: 2, breaches: 1, ratingSum: 9, ratingCount: 2, dist: [0, 0, 1, 0, 1] as [number, number, number, number, number] };
    const b = { ...emptyBucket(), tickets: 1, fr: [30], decided: 1, within: 1, ratingSum: 4, ratingCount: 1, dist: [0, 0, 0, 1, 0] as [number, number, number, number, number] };
    addBucket(a, b);
    expect(toStats(a)).toMatchObject({ tickets: 4, firstResponseMedianMinutes: 20, withinSlaPercent: 75, breaches: 1, ratingAverage: 4.33, ratingCount: 3 });
    expect(a.dist).toEqual([0, 0, 1, 1, 1]);
    expect(toStats(emptyBucket())).toMatchObject({ withinSlaPercent: null, ratingAverage: null, firstResponseMedianMinutes: null });
  });
});
