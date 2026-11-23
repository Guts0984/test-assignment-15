import { computeSlaDeadlines, type HoursCalendar } from '@helpdesk/shared';
import { describe, expect, it } from 'vitest';
import { buildLiveSet, type LiveAgent, type LiveInput } from './live-tickets';
import { createRng } from './rng';

const cal = (tz: string): HoursCalendar => ({
  kind: 'hours',
  timeZone: tz,
  workdays: [1, 2, 3, 4, 5],
  startMinute: 540,
  endMinute: 1080,
  holidays: [],
});
const teams = [
  { id: 't1', calendar: cal('Europe/Kyiv'), mailbox: 'support@helpdesk.test' },
  { id: 't2', calendar: cal('Europe/Warsaw'), mailbox: 'pl@helpdesk.test' },
];
const agents: LiveAgent[] = Array.from({ length: 10 }, (_, i) => ({
  id: `a${i}`,
  teamId: i < 5 ? 't1' : 't2',
  limit: 5 + (i % 3),
  languages: ['en'],
  onShift: i !== 4,
}));

const input = (now: Date, over: Partial<LiveInput> = {}): LiveInput => ({
  now,
  rng: createRng(99),
  teams,
  agents,
  customerIds: ['c1', 'c2'],
  subjects: ['Subject'],
  bodies: ['Body'],
  active: 120,
  breachSoon: 12,
  warnSoon: 8,
  resolved: 6,
  warningRatio: 0.8,
  ...over,
});

describe('buildLiveSet', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const set = buildLiveSet(input(now));

  it('builds the requested number of open and resolved tickets', () => {
    expect(set.tickets.filter((t) => t.status !== 'resolved')).toHaveLength(120);
    expect(set.tickets.filter((t) => t.status === 'resolved')).toHaveLength(6);
  });

  it('makes the breach-soon tickets breach their first response 1-10 minutes from now, whatever the time of day', () => {
    for (const hour of [0, 3, 12, 22]) {
      const at = new Date(Date.UTC(2026, 5, 10, hour, 7));
      const s = buildLiveSet(input(at));
      const soon = s.tickets
        .filter((t) => t.priority === 'urgent' && t.firstRespondedAt === null && t.status === 'new')
        .slice(0, 12);
      const due = soon.filter(
        (t) =>
          t.sla.firstResponseDueAt.getTime() > at.getTime() &&
          t.sla.firstResponseDueAt.getTime() <= at.getTime() + 10 * 60_000,
      );
      expect(due.length).toBeGreaterThanOrEqual(12);
    }
  });

  it('creates pending timer jobs only for the future and marks past ones done', () => {
    const nowMs = now.getTime();
    for (const j of set.jobs.filter((x) => x.kind !== 'auto_close')) {
      expect(j.status).toBe(j.runAt.getTime() <= nowMs ? 'done' : 'pending');
    }
    expect(new Set(set.jobs.map((j) => j.dedupeKey)).size).toBe(set.jobs.length);
    expect(set.jobs.filter((j) => j.kind === 'auto_close')).toHaveLength(6);
  });

  it('uses the shared calculator for every deadline', () => {
    for (const t of set.tickets) {
      const team = teams.find((x) => x.id === t.teamId);
      const r = computeSlaDeadlines({
        priority: t.priority,
        createdAt: t.createdAt,
        calendar: team?.calendar ?? cal('UTC'),
        pauses: set.pauses.filter((p) => p.ticketId === t.id),
        warningRatio: 0.8,
      });
      expect(r.ok && r.value.firstResponseDueAt.getTime()).toBe(t.sla.firstResponseDueAt.getTime());
      expect(r.ok && r.value.resolutionDueAt?.getTime()).toBe(t.sla.resolutionDueAt?.getTime());
    }
  });

  it('never exceeds an agent limit and never assigns off-shift agents', () => {
    const counts = new Map<string, number>();
    for (const t of set.tickets) {
      if (t.assigneeId === null || t.status === 'resolved') continue;
      counts.set(t.assigneeId, (counts.get(t.assigneeId) ?? 0) + 1);
      expect(t.assigneeId).not.toBe('a4');
    }
    for (const [id, n] of counts)
      expect(n).toBeLessThanOrEqual(agents.find((a) => a.id === id)?.limit ?? 0);
  });

  it('waiting_customer tickets have an open pause and no resolution deadline; messages are consistent', () => {
    for (const t of set.tickets.filter((x) => x.status === 'waiting_customer')) {
      expect(t.sla.paused).toBe(true);
      expect(t.sla.resolutionDueAt).toBeNull();
      expect(set.pauses.some((p) => p.ticketId === t.id && p.endedAt === null)).toBe(true);
    }
    for (const t of set.tickets) {
      const ms = set.messages.filter((m) => m.ticketId === t.id);
      expect(ms.map((m) => m.seq)).toEqual(ms.map((_, i) => i + 1));
      expect(t.messageSeq).toBe(ms.length);
    }
  });

  it('is deterministic for the same seed and time', () => {
    const again = buildLiveSet(input(now));
    expect(
      again.tickets.map((t) => [t.priority, t.status, t.sla.firstResponseDueAt.getTime()]),
    ).toEqual(set.tickets.map((t) => [t.priority, t.status, t.sla.firstResponseDueAt.getTime()]));
  });
});
