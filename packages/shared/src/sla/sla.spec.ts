import { describe, expect, it } from 'vitest';
import { ALWAYS, businessMsBetween, type BusinessCalendar } from '../business-time/business-time';
import { HOUR, officeCalendar, utc } from '../business-time/fixtures';
import { PRIORITIES, type Priority } from '../domain/constants';
import {
  calendarFor,
  computeSlaDeadlines,
  dueSlaEvents,
  nextDueAt,
  remainingMs,
  SLA_POLICY,
  type Pause,
  type SlaDeadlines,
} from './sla';

const kyiv = officeCalendar('Europe/Kyiv');

const sla = (
  priority: Priority,
  createdAt: string,
  calendar: BusinessCalendar = kyiv,
  pauses: readonly Pause[] = [],
): SlaDeadlines => {
  const r = computeSlaDeadlines({
    priority,
    createdAt: new Date(createdAt),
    calendar,
    pauses,
    warningRatio: 0.8,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('SLA policy table', () => {
  it('urgent runs 24/7: 1 h first response, 4 h resolution (even on a Sunday night)', () => {
    const d = sla('urgent', '2026-01-18T22:30:00Z');
    expect(d.firstResponseDueAt.toISOString()).toBe('2026-01-18T23:30:00.000Z');
    expect(d.resolutionDueAt?.toISOString()).toBe('2026-01-19T02:30:00.000Z');
  });

  it('high: 4 business hours / 1 business day', () => {
    // Wed 2026-01-14 10:00 Kyiv (08:00Z)
    const d = sla('high', '2026-01-14T08:00:00Z');
    expect(d.firstResponseDueAt.toISOString()).toBe('2026-01-14T12:00:00.000Z');
    // 1 business day = 9 h: 8h left today + 1h tomorrow -> Thu 10:00 Kyiv
    expect(d.resolutionDueAt?.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('normal: 8 business hours / 3 business days', () => {
    const d = sla('normal', '2026-01-14T07:00:00Z'); // 09:00 Kyiv
    expect(d.firstResponseDueAt.toISOString()).toBe('2026-01-14T15:00:00.000Z'); // 17:00 Kyiv
    expect(d.resolutionDueAt?.toISOString()).toBe('2026-01-16T16:00:00.000Z'); // Fri 18:00 Kyiv
  });

  it('low: 2 business days / 5 business days', () => {
    const d = sla('low', '2026-01-12T07:00:00Z'); // Mon 09:00 Kyiv
    expect(d.firstResponseDueAt.toISOString()).toBe('2026-01-13T16:00:00.000Z'); // Tue 18:00
    expect(d.resolutionDueAt?.toISOString()).toBe('2026-01-16T16:00:00.000Z'); // Fri 18:00
  });

  it('every priority has a first-response target shorter than its resolution target', () => {
    for (const p of PRIORITIES) {
      const d = sla(p, '2026-01-14T07:00:00Z');
      expect(d.firstResponseDueAt.getTime()).toBeLessThan(d.resolutionDueAt?.getTime() ?? 0);
    }
  });

  it('urgent ignores the team calendar', () => {
    expect(calendarFor('urgent', kyiv)).toBe(ALWAYS);
    expect(calendarFor('high', kyiv)).toBe(kyiv);
    expect(SLA_POLICY.urgent.wallClock).toBe(true);
  });

  it('warning points are at 80% of the business time', () => {
    const d = sla('normal', '2026-01-14T07:00:00Z'); // 8h target -> 6.4h
    expect(d.firstResponseWarnAt.getTime() - utc('2026-01-14T07:00:00Z')).toBe(6.4 * HOUR);
    const u = sla('urgent', '2026-01-14T07:00:00Z'); // 1h -> 48 min
    expect(u.firstResponseWarnAt.getTime() - utc('2026-01-14T07:00:00Z')).toBe(48 * 60_000);
  });
});

describe('acceptance checks 3, 4 and 5', () => {
  it('ACC-3: high on Friday 16:00 Kyiv, team 09:00-18:00 -> first response due Monday 11:00 Kyiv', () => {
    const d = sla('high', '2026-01-16T14:00:00Z');
    expect(d.firstResponseDueAt.toISOString()).toBe('2026-01-19T09:00:00.000Z'); // 11:00 EET
  });

  it('ACC-4: normal created Saturday before DST, Monday is a team holiday', () => {
    const cal = officeCalendar('Europe/Kyiv', ['2026-03-30']);
    const d = sla('normal', '2026-03-28T10:00:00Z', cal); // Sat 12:00 EET; DST starts Sun 2026-03-29
    // Mon is a holiday; first business time is Tue 09:00 EEST (+3). 8h -> Tue 17:00 EEST = 14:00Z
    expect(d.firstResponseDueAt.toISOString()).toBe('2026-03-31T14:00:00.000Z');
    // 3 business days = 27h: Tue, Wed, Thu -> Thu 2026-04-02 18:00 EEST = 15:00Z
    expect(d.resolutionDueAt?.toISOString()).toBe('2026-04-02T15:00:00.000Z');
  });

  it('ACC-5: two hours in waiting_customer move the resolution deadline by exactly two hours', () => {
    const created = '2026-01-12T07:00:00Z'; // Mon 09:00 Kyiv
    const base = sla('normal', created);
    const paused = sla('normal', created, kyiv, [
      { startedAt: new Date('2026-01-13T08:00:00Z'), endedAt: new Date('2026-01-13T10:00:00Z') }, // Tue 10:00-12:00 Kyiv
    ]);
    const shifted = (a: Date | null, b: Date | null): number =>
      businessMsBetween(kyiv, b?.getTime() ?? 0, a?.getTime() ?? 0);
    expect(shifted(paused.resolutionDueAt, base.resolutionDueAt)).toBe(2 * HOUR);
    expect(shifted(paused.resolutionWarnAt, base.resolutionWarnAt)).toBe(2 * HOUR);
    // Wed 18:00 Kyiv -> Thu 11:00 Kyiv
    expect(base.resolutionDueAt?.toISOString()).toBe('2026-01-14T16:00:00.000Z');
    expect(paused.resolutionDueAt?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(paused.firstResponseDueAt.getTime()).toBe(base.firstResponseDueAt.getTime());
  });
});

describe('pauses', () => {
  const created = '2026-01-12T07:00:00Z'; // Mon 09:00 Kyiv

  it('an open pause suspends the resolution deadline but not the first-response deadline', () => {
    const d = sla('normal', created, kyiv, [
      { startedAt: new Date('2026-01-13T08:00:00Z'), endedAt: null },
    ]);
    expect(d.paused).toBe(true);
    expect(d.resolutionDueAt).toBeNull();
    expect(d.resolutionWarnAt).toBeNull();
    expect(d.firstResponseDueAt).toBeInstanceOf(Date);
  });

  it('a pause spanning closing time and a weekend only counts business time', () => {
    const base = sla('low', created);
    // Fri 17:00 Kyiv -> Mon 10:00 Kyiv covers 1h Fri + 1h Mon = 2 business hours (needs the fixed-point step)
    const d = sla('low', created, kyiv, [
      { startedAt: new Date('2026-01-16T15:00:00Z'), endedAt: new Date('2026-01-19T08:00:00Z') },
    ]);
    expect(base.resolutionDueAt?.toISOString()).toBe('2026-01-16T16:00:00.000Z'); // Fri 18:00
    expect(d.resolutionDueAt?.toISOString()).toBe('2026-01-19T09:00:00.000Z'); // Mon 11:00
  });

  it('a pause that starts after the original deadline does not move it', () => {
    const base = sla('normal', created);
    const d = sla('normal', created, kyiv, [
      { startedAt: new Date('2026-01-15T08:00:00Z'), endedAt: new Date('2026-01-15T10:00:00Z') },
    ]);
    expect(d.resolutionDueAt?.getTime()).toBe(base.resolutionDueAt?.getTime());
  });

  it('a pause entirely outside business hours changes nothing', () => {
    const base = sla('normal', created);
    const d = sla('normal', created, kyiv, [
      { startedAt: new Date('2026-01-12T17:00:00Z'), endedAt: new Date('2026-01-13T05:00:00Z') }, // 19:00 Mon - 07:00 Tue
    ]);
    expect(d.resolutionDueAt?.getTime()).toBe(base.resolutionDueAt?.getTime());
  });

  it('several pauses add up', () => {
    const base = sla('normal', created);
    const d = sla('normal', created, kyiv, [
      { startedAt: new Date('2026-01-12T09:00:00Z'), endedAt: new Date('2026-01-12T10:00:00Z') },
      { startedAt: new Date('2026-01-13T09:00:00Z'), endedAt: new Date('2026-01-13T11:00:00Z') },
    ]);
    expect(
      businessMsBetween(
        kyiv,
        base.resolutionDueAt?.getTime() ?? 0,
        d.resolutionDueAt?.getTime() ?? 0,
      ),
    ).toBe(3 * HOUR);
  });

  it('urgent pauses count wall-clock time', () => {
    const base = sla('urgent', '2026-01-17T10:00:00Z');
    const d = sla('urgent', '2026-01-17T10:00:00Z', kyiv, [
      { startedAt: new Date('2026-01-17T11:00:00Z'), endedAt: new Date('2026-01-17T13:30:00Z') },
    ]);
    expect((d.resolutionDueAt?.getTime() ?? 0) - (base.resolutionDueAt?.getTime() ?? 0)).toBe(
      2.5 * HOUR,
    );
  });
});

describe('recomputation on priority or team change', () => {
  const created = '2026-01-16T14:00:00Z'; // Fri 16:00 Kyiv

  it('recomputes from the creation time under the new priority', () => {
    const normal = sla('normal', created);
    const high = sla('high', created);
    expect(high.firstResponseDueAt.getTime()).toBeLessThan(normal.firstResponseDueAt.getTime());
    // switching back reproduces the original exactly (pure function of inputs)
    expect(sla('normal', created).firstResponseDueAt.getTime()).toBe(
      normal.firstResponseDueAt.getTime(),
    );
  });

  it('recomputes under the new team calendar and time zone', () => {
    const kyivDue = sla('high', created, officeCalendar('Europe/Kyiv'));
    const warsawDue = sla('high', created, officeCalendar('Europe/Warsaw'));
    // Warsaw is one hour behind Kyiv: 16:00 Kyiv = 15:00 Warsaw, so 3h left on Friday
    expect(kyivDue.firstResponseDueAt.toISOString()).toBe('2026-01-19T09:00:00.000Z');
    expect(warsawDue.firstResponseDueAt.toISOString()).toBe('2026-01-19T09:00:00.000Z');
    const night = sla('high', '2026-01-16T15:30:00Z', officeCalendar('Europe/Warsaw'));
    expect(night.firstResponseDueAt.toISOString()).not.toBe(
      kyivDue.firstResponseDueAt.toISOString(),
    );
  });
});

describe('queue ordering and timer helpers', () => {
  const d = sla('normal', '2026-01-14T07:00:00Z');

  it('nextDueAt is first response until it is given, then resolution, then nothing', () => {
    expect(nextDueAt(d, { firstRespondedAt: null, resolvedAt: null })).toEqual(
      d.firstResponseDueAt,
    );
    expect(nextDueAt(d, { firstRespondedAt: new Date(), resolvedAt: null })).toEqual(
      d.resolutionDueAt,
    );
    expect(nextDueAt(d, { firstRespondedAt: new Date(), resolvedAt: new Date() })).toBeNull();
  });

  it('nextDueAt is null while paused after the first response', () => {
    const paused = sla('normal', '2026-01-14T07:00:00Z', kyiv, [
      { startedAt: new Date('2026-01-14T09:00:00Z'), endedAt: null },
    ]);
    expect(nextDueAt(paused, { firstRespondedAt: new Date(), resolvedAt: null })).toBeNull();
  });

  it('remainingMs is negative when overdue', () => {
    expect(remainingMs(new Date(1000), 400)).toBe(600);
    expect(remainingMs(new Date(1000), 1500)).toBe(-500);
  });

  it('dueSlaEvents reports each event once, in time order, and respects the fired set', () => {
    const now = new Date(d.resolutionDueAt?.getTime() ?? 0);
    const open = { firstRespondedAt: new Date(), resolvedAt: null };
    const events = dueSlaEvents(d, open, new Set(), now);
    expect(events.map((e) => `${e.target}:${e.event}`)).toEqual([
      'resolution:warning',
      'resolution:breach',
    ]);
    const after = dueSlaEvents(d, open, new Set(['resolution:warning']), now);
    expect(after.map((e) => e.event)).toEqual(['breach']);
    expect(
      dueSlaEvents(d, open, new Set(['resolution:warning', 'resolution:breach']), now),
    ).toEqual([]);
  });

  it('dueSlaEvents is exact at the boundary: nothing one millisecond early, fires at the instant', () => {
    const none = { firstRespondedAt: null, resolvedAt: null };
    const due = d.firstResponseDueAt.getTime();
    const early = dueSlaEvents(d, none, new Set(['first_response:warning']), new Date(due - 1));
    expect(early).toEqual([]);
    const exact = dueSlaEvents(d, none, new Set(['first_response:warning']), new Date(due));
    expect(exact.map((e) => e.event)).toEqual(['breach']);
  });

  it('a responded ticket no longer produces first-response events; a resolved one no resolution events', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const ev = dueSlaEvents(
      d,
      { firstRespondedAt: new Date(), resolvedAt: new Date() },
      new Set(),
      now,
    );
    expect(ev).toEqual([]);
  });
});
