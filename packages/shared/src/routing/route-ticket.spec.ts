import { describe, expect, it } from 'vitest';
import { routeTicket, subjectHasKeyword, type RoutingRule } from './route-ticket';

const rule = (id: string, over: Partial<RoutingRule>): RoutingRule => ({
  id,
  position: 0,
  enabled: true,
  recipient: null,
  subjectKeywords: [],
  language: null,
  teamId: `team-${id}`,
  priority: null,
  ...over,
});

const input = {
  recipient: 'billing@helpdesk.test',
  subject: 'Invoice question',
  language: 'en' as const,
};

describe('routeTicket', () => {
  it('falls back to the mailbox default team with normal priority', () => {
    expect(routeTicket([], input, 'default')).toEqual({
      teamId: 'default',
      priority: 'normal',
      ruleId: null,
    });
  });

  it('matches by recipient address, case-insensitively', () => {
    const r = routeTicket([rule('r1', { recipient: 'Billing@Helpdesk.test' })], input, 'default');
    expect(r.teamId).toBe('team-r1');
  });

  it('matches subject keywords on word boundaries only', () => {
    expect(subjectHasKeyword('Invoice question', 'invoice')).toBe(true);
    expect(subjectHasKeyword('Invoices overdue', 'invoice')).toBe(false);
    expect(subjectHasKeyword('Re: [#1] refund-request', 'refund')).toBe(true);
    expect(subjectHasKeyword('anything', '')).toBe(false);
    expect(subjectHasKeyword('a.b (c)', 'a.b')).toBe(true);
    expect(subjectHasKeyword('axb', 'a.b')).toBe(false);
  });

  it('requires ALL set conditions to hold', () => {
    const both = rule('r1', { recipient: 'billing@helpdesk.test', language: 'pl' });
    expect(routeTicket([both], input, 'default').teamId).toBe('default');
    expect(routeTicket([both], { ...input, language: 'pl' }, 'default').teamId).toBe('team-r1');
  });

  it('first enabled rule by position wins and carries its priority', () => {
    const rules = [
      rule('late', { position: 5, subjectKeywords: ['invoice'], priority: 'low' }),
      rule('early', { position: 1, subjectKeywords: ['invoice'], priority: 'high' }),
      rule('off', { position: 0, subjectKeywords: ['invoice'], enabled: false }),
    ];
    expect(routeTicket(rules, input, 'default')).toEqual({
      teamId: 'team-early',
      priority: 'high',
      ruleId: 'early',
    });
  });

  it('a rule with no conditions never matches (cannot swallow everything)', () => {
    expect(routeTicket([rule('empty', {})], input, 'default').teamId).toBe('default');
  });
});
