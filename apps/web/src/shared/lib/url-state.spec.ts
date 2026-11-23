import { describe, expect, it } from 'vitest';
import { defaultFilters, parseFilters, serializeFilters } from './url-state';

const today = new Date('2026-03-10T12:00:00Z');
const team = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('report filters in the URL', () => {
  it('defaults to the last 30 days', () => {
    expect(defaultFilters(today)).toMatchObject({ from: '2026-02-09', to: '2026-03-10' });
  });

  it('round-trips through the query string (reload and Back restore the same state)', () => {
    const f = { from: '2026-01-01', to: '2026-03-31', teamId: team, agentId: '', priority: 'high' };
    expect(parseFilters(new URLSearchParams(serializeFilters(f)), today)).toEqual(f);
  });

  it('ignores malformed values instead of failing', () => {
    const f = parseFilters(
      new URLSearchParams('from=yesterday&to=2026-99-99&team=abc&agent=%00&priority=ultra'),
      today,
    );
    expect(f).toEqual(defaultFilters(today));
    expect(f.teamId).toBe('');
    expect(f.priority).toBe('');
  });

  it('repairs a reversed period', () => {
    const f = parseFilters(new URLSearchParams('from=2026-03-05&to=2026-03-01'), today);
    expect(f.from <= f.to).toBe(true);
  });
});
