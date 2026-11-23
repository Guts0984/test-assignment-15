import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { selectAgent, type AgentCandidate } from './select-agent';

const agent = (id: string, over: Partial<AgentCandidate> = {}): AgentCandidate => ({
  userId: id,
  role: 'agent',
  active: true,
  onShift: true,
  openCount: 0,
  limit: 5,
  lastAssignedAt: null,
  languages: ['en'],
  ...over,
});

describe('selectAgent', () => {
  it('picks the agent with the fewest open tickets', () => {
    expect(
      selectAgent(
        [agent('a', { openCount: 3 }), agent('b', { openCount: 1 }), agent('c', { openCount: 2 })],
        'en',
      ),
    ).toBe('b');
  });

  it('breaks ties by who has gone longest without a new ticket (never assigned first)', () => {
    const team = [
      agent('a', { lastAssignedAt: new Date('2026-01-01T10:00:00Z') }),
      agent('b', { lastAssignedAt: new Date('2026-01-01T09:00:00Z') }),
      agent('c', { lastAssignedAt: null }),
    ];
    expect(selectAgent(team, 'en')).toBe('c');
    expect(selectAgent(team.slice(0, 2), 'en')).toBe('b');
  });

  it('breaks remaining ties by user id for a deterministic result', () => {
    expect(selectAgent([agent('b'), agent('a')], 'en')).toBe('a');
  });

  it('never selects an agent who is off shift, inactive, a lead, or at their limit', () => {
    const team = [
      agent('off', { onShift: false }),
      agent('inactive', { active: false }),
      agent('lead', { role: 'lead' }),
      agent('full', { openCount: 5, limit: 5 }),
      agent('over', { openCount: 9, limit: 5 }),
    ];
    expect(selectAgent(team, 'en')).toBeNull();
  });

  it('returns null for an empty team', () => {
    expect(selectAgent([], 'en')).toBeNull();
  });

  it('prefers agents who speak the ticket language', () => {
    const team = [
      agent('en-only', { openCount: 0 }),
      agent('pl', { openCount: 4, languages: ['en', 'pl'] }),
    ];
    expect(selectAgent(team, 'pl')).toBe('pl');
  });

  it('waits (null) when the only speaker of the language is full, instead of picking a non-speaker', () => {
    const team = [agent('en-only'), agent('pl', { openCount: 5, languages: ['pl'] })];
    expect(selectAgent(team, 'pl')).toBeNull();
  });

  it('drops the language filter when nobody on the team speaks it', () => {
    expect(selectAgent([agent('a'), agent('b', { openCount: 2 })], 'de')).toBe('a');
  });

  it('property: never returns an agent at their limit; repeated picks keep loads within one', () => {
    const teamArb = fc.array(
      fc.record({ limit: fc.integer({ min: 1, max: 6 }), onShift: fc.boolean() }),
      { minLength: 1, maxLength: 8 },
    );
    fc.assert(
      fc.property(teamArb, fc.integer({ min: 1, max: 60 }), (spec, tickets) => {
        const loads = new Map<string, number>(spec.map((_, i) => [`u${i}`, 0]));
        let clock = 0;
        const last = new Map<string, Date | null>();
        for (let n = 0; n < tickets; n += 1) {
          const team = spec.map((s, i) =>
            agent(`u${i}`, {
              limit: s.limit,
              onShift: s.onShift,
              openCount: loads.get(`u${i}`) ?? 0,
              lastAssignedAt: last.get(`u${i}`) ?? null,
            }),
          );
          const pick = selectAgent(team, 'en');
          if (pick === null) continue;
          const idx = Number(pick.slice(1));
          expect(loads.get(pick) ?? 0).toBeLessThan(spec[idx]?.limit ?? 0);
          loads.set(pick, (loads.get(pick) ?? 0) + 1);
          clock += 1;
          last.set(pick, new Date(clock));
        }
        const unlimited = spec.map((s, i) => ({ s, i })).filter(({ s }) => s.onShift);
        if (unlimited.length > 0 && unlimited.every(({ s }) => s.limit >= tickets)) {
          const counts = unlimited.map(({ i }) => loads.get(`u${i}`) ?? 0);
          expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
