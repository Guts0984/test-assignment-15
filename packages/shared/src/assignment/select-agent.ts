import type { Language } from '../domain/constants';

export type AgentCandidate = {
  readonly userId: string;
  readonly role: 'agent' | 'lead';
  readonly active: boolean;
  readonly onShift: boolean;
  readonly openCount: number;
  readonly limit: number;
  /** Null when the agent has never been assigned a ticket. */
  readonly lastAssignedAt: Date | null;
  readonly languages: readonly Language[];
};

/** True when at least one agent could take a ticket right now, whatever its language. */
export const hasFreeAgent = (team: readonly AgentCandidate[]): boolean => team.some(eligible);

const eligible = (c: AgentCandidate): boolean =>
  c.role === 'agent' && c.active && c.onShift && c.openCount < c.limit;

/**
 * Picks the agent for a ticket: on shift, under the limit, speaking the ticket language;
 * fewest open tickets; tie -> longest without a new ticket (never assigned first); then user id.
 * If nobody on the whole team speaks the language, the language filter is dropped so tickets never starve.
 * Returns null when nobody is free (the ticket waits in the team queue).
 */
export const selectAgent = (team: readonly AgentCandidate[], language: Language): string | null => {
  const teamSpeaksIt = team.some(
    (c) => c.role === 'agent' && c.active && c.languages.includes(language),
  );
  const pool = team.filter((c) => eligible(c) && (!teamSpeaksIt || c.languages.includes(language)));
  const best = [...pool].sort(compareCandidates)[0];
  return best?.userId ?? null;
};

export const compareCandidates = (a: AgentCandidate, b: AgentCandidate): number => {
  if (a.openCount !== b.openCount) return a.openCount - b.openCount;
  const ta = a.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const tb = b.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
};
