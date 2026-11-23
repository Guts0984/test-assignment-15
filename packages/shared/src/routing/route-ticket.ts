import type { Language, Priority } from '../domain/constants';

export type RoutingRule = {
  readonly id: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly recipient: string | null;
  readonly subjectKeywords: readonly string[];
  readonly language: Language | null;
  readonly teamId: string;
  readonly priority: Priority | null;
};

export type RoutingInput = {
  readonly recipient: string;
  readonly subject: string;
  readonly language: Language;
};

export type RoutingDecision = {
  readonly teamId: string;
  readonly priority: Priority;
  readonly ruleId: string | null;
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive match on word boundaries, so "pay" does not match "payment" unless listed. */
export const subjectHasKeyword = (subject: string, keyword: string): boolean => {
  const k = keyword.trim();
  if (k === '') return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(k)}($|[^\\p{L}\\p{N}])`, 'iu').test(subject);
};

const matches = (rule: RoutingRule, input: RoutingInput): boolean => {
  if (rule.recipient !== null && rule.recipient.toLowerCase() !== input.recipient.toLowerCase())
    return false;
  if (
    rule.subjectKeywords.length > 0 &&
    !rule.subjectKeywords.some((k) => subjectHasKeyword(input.subject, k))
  )
    return false;
  if (rule.language !== null && rule.language !== input.language) return false;
  return rule.recipient !== null || rule.subjectKeywords.length > 0 || rule.language !== null;
};

/** First enabled matching rule by position wins; otherwise the mailbox's default team. */
export const routeTicket = (
  rules: readonly RoutingRule[],
  input: RoutingInput,
  mailboxDefaultTeamId: string,
): RoutingDecision => {
  const hit = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.position - b.position)
    .find((r) => matches(r, input));
  return hit
    ? { teamId: hit.teamId, priority: hit.priority ?? 'normal', ruleId: hit.id }
    : { teamId: mailboxDefaultTeamId, priority: 'normal', ruleId: null };
};
