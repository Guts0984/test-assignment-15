import { describe, expect, it } from 'vitest';
import {
  agentInput,
  holidayInput,
  loginInput,
  mergeInput,
  noteInput,
  publicTicketInput,
  replyInput,
  reportQueryInput,
  routingRuleInput,
  searchQueryInput,
  surveyRatingInput,
  teamInput,
} from './inputs';

const uuidA = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('input schemas', () => {
  it('rejects unknown keys everywhere (mass assignment)', () => {
    expect(noteInput.safeParse({ body: 'x', isInternal: false }).success).toBe(false);
    expect(replyInput.safeParse({ body: 'x', lastSeenSeq: 0, role: 'admin' }).success).toBe(false);
    expect(mergeInput.safeParse({ targetTicketId: uuidA, status: 'closed' }).success).toBe(false);
    expect(loginInput.safeParse({ email: 'a@b.test', password: 'x', admin: true }).success).toBe(
      false,
    );
  });

  it('survives prototype-pollution style keys without touching Object.prototype', () => {
    const parsed = JSON.parse('{"body":"x","__proto__":{"polluted":true}}');
    noteInput.safeParse(parsed);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('normalizes emails and rejects header-injection attempts', () => {
    const ok = loginInput.safeParse({ email: '  Ann@Example.COM ', password: 'p' });
    expect(ok.success && ok.data.email).toBe('ann@example.com');
    expect(
      loginInput.safeParse({ email: 'a@b.test\r\nBcc: x@y.test', password: 'p' }).success,
    ).toBe(false);
  });

  it('subjects are single-line, bounded and free of control characters', () => {
    const base = { email: 'a@b.test', name: 'Ann', body: 'Hello' };
    expect(publicTicketInput.safeParse({ ...base, subject: 'Printer broken' }).success).toBe(true);
    expect(publicTicketInput.safeParse({ ...base, subject: 'A\nB' }).success).toBe(false);
    expect(publicTicketInput.safeParse({ ...base, subject: 'A\u0000B' }).success).toBe(false);
    expect(publicTicketInput.safeParse({ ...base, subject: 'x'.repeat(301) }).success).toBe(false);
    expect(publicTicketInput.safeParse({ ...base, subject: '   ' }).success).toBe(false);
  });

  it('bodies reject NUL bytes and oversize text but accept newlines and tabs', () => {
    expect(noteInput.safeParse({ body: 'line1\n\tline2' }).success).toBe(true);
    expect(noteInput.safeParse({ body: 'a\u0000b' }).success).toBe(false);
    expect(noteInput.safeParse({ body: 'x'.repeat(100_001) }).success).toBe(false);
    expect(noteInput.safeParse({ body: '' }).success).toBe(false);
  });

  it('reply requires a non-negative integer lastSeenSeq', () => {
    expect(replyInput.safeParse({ body: 'x', lastSeenSeq: -1 }).success).toBe(false);
    expect(replyInput.safeParse({ body: 'x', lastSeenSeq: 1.5 }).success).toBe(false);
    expect(replyInput.safeParse({ body: 'x', lastSeenSeq: 3 }).success).toBe(true);
  });

  it('survey rating is an integer 1..5', () => {
    for (const bad of [0, 6, 2.5, -1, '3'])
      expect(surveyRatingInput.safeParse({ rating: bad }).success).toBe(false);
    expect(surveyRatingInput.safeParse({ rating: 5, comment: 'ok' }).success).toBe(true);
  });

  it('search query is bounded and pagination is sane', () => {
    expect(searchQueryInput.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(searchQueryInput.safeParse({ q: 'ok', limit: '0' }).success).toBe(false);
    expect(searchQueryInput.safeParse({ q: 'ok', limit: '-5' }).success).toBe(false);
    expect(searchQueryInput.safeParse({ q: 'ok', limit: '101' }).success).toBe(false);
    const ok = searchQueryInput.safeParse({ q: ' ok ', limit: '20' });
    expect(ok.success && ok.data).toMatchObject({ q: 'ok', limit: 20 });
  });

  it('report period must be real dates in order', () => {
    expect(reportQueryInput.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(
      false,
    );
    expect(reportQueryInput.safeParse({ from: '2026-03-02', to: '2026-03-01' }).success).toBe(
      false,
    );
    expect(
      reportQueryInput.safeParse({ from: '2026-01-01', to: '2026-03-31', priority: 'high' })
        .success,
    ).toBe(true);
  });

  it('a report covers at most 366 days (review F21)', () => {
    expect(reportQueryInput.safeParse({ from: '2025-01-01', to: '2026-01-01' }).success).toBe(true);
    expect(reportQueryInput.safeParse({ from: '2000-01-01', to: '2026-01-01' }).success).toBe(
      false,
    );
  });

  it('team hours need a real time zone and an end after the start', () => {
    const base = {
      name: 'Support',
      defaultLanguage: 'en',
      timeZone: 'Europe/Kyiv',
      workdays: [1, 2, 3, 4, 5],
      workStart: '09:00',
      workEnd: '18:00',
    };
    expect(teamInput.safeParse(base).success).toBe(true);
    expect(teamInput.safeParse({ ...base, timeZone: 'Nowhere/City' }).success).toBe(false);
    expect(teamInput.safeParse({ ...base, workEnd: '08:00' }).success).toBe(false);
    expect(teamInput.safeParse({ ...base, workdays: [] }).success).toBe(false);
    expect(teamInput.safeParse({ ...base, workdays: [8] }).success).toBe(false);
    expect(teamInput.safeParse({ ...base, workEnd: '24:00' }).success).toBe(true);
  });

  it('holidays need a real calendar date', () => {
    expect(holidayInput.safeParse({ date: '2026-12-25', name: 'Christmas' }).success).toBe(true);
    expect(holidayInput.safeParse({ date: '2026-13-01', name: 'x' }).success).toBe(false);
  });

  it('routing rules need at least one condition', () => {
    expect(routingRuleInput.safeParse({ position: 1, teamId: uuidA }).success).toBe(false);
    expect(
      routingRuleInput.safeParse({ position: 1, teamId: uuidA, subjectKeywords: ['refund'] })
        .success,
    ).toBe(true);
  });

  it('agents have bounded limits and at least one language', () => {
    const base = {
      email: 'a@b.test',
      name: 'Ann',
      ticketLimit: 20,
      languages: ['en'],
      memberships: [{ teamId: uuidA, role: 'agent' }],
    };
    expect(agentInput.safeParse(base).success).toBe(true);
    expect(agentInput.safeParse({ ...base, ticketLimit: -1 }).success).toBe(false);
    expect(agentInput.safeParse({ ...base, languages: [] }).success).toBe(false);
    expect(agentInput.safeParse({ ...base, languages: ['xx'] }).success).toBe(false);
    expect(
      agentInput.safeParse({ ...base, memberships: [{ teamId: uuidA, role: 'owner' }] }).success,
    ).toBe(false);
  });
});
