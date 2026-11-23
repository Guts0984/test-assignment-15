import { describe, expect, it } from 'vitest';
import type { TicketListItem } from '@/shared/api';
import { byDeadline, currentDeadline } from './ticket-model';

const t = (over: Partial<TicketListItem>): TicketListItem =>
  ({
    id: 'i',
    number: 1,
    subject: 's',
    status: 'open',
    priority: 'normal',
    language: 'en',
    teamId: 't',
    assigneeId: null,
    assigneeName: null,
    customerName: 'c',
    customerEmail: 'c@x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextDueAt: null,
    firstResponseDueAt: '2026-01-01T01:00:00.000Z',
    resolutionDueAt: '2026-01-02T00:00:00.000Z',
    slaPaused: false,
    firstRespondedAt: null,
    firstResponseBreached: false,
    resolutionBreached: false,
    version: 1,
    ...over,
  }) as TicketListItem;

describe('ticket model', () => {
  it('counts down to first response, then resolution, and stops when paused, resolved or closed', () => {
    expect(currentDeadline(t({}))).toEqual({
      label: 'First response',
      at: '2026-01-01T01:00:00.000Z',
    });
    expect(currentDeadline(t({ firstRespondedAt: '2026-01-01T00:10:00.000Z' }))).toEqual({
      label: 'Resolution',
      at: '2026-01-02T00:00:00.000Z',
    });
    expect(currentDeadline(t({ firstRespondedAt: 'x', slaPaused: true }))).toBeNull();
    expect(currentDeadline(t({ status: 'resolved' }))).toBeNull();
    expect(currentDeadline(t({ status: 'closed' }))).toBeNull();
  });
  it('sorts by deadline with undated tickets last', () => {
    const list = [
      t({ id: 'none' }),
      t({ id: 'late', nextDueAt: '2026-01-03T00:00:00.000Z' }),
      t({ id: 'soon', nextDueAt: '2026-01-01T00:30:00.000Z' }),
    ];
    expect([...list].sort(byDeadline).map((x) => x.id)).toEqual(['soon', 'late', 'none']);
  });
});
