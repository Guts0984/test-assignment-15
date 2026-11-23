import { describe, expect, it } from 'vitest';
import {
  holidaysFor,
  orthodoxEaster,
  polandHolidays,
  ukraineHolidays,
  westernEaster,
} from './holidays';

describe('holiday calendars', () => {
  it('computes known Western Easter dates', () => {
    expect(westernEaster(2025)).toEqual([2025, 4, 20]);
    expect(westernEaster(2026)).toEqual([2026, 4, 5]);
    expect(westernEaster(2027)).toEqual([2027, 3, 28]);
  });

  it('computes known Orthodox Easter dates', () => {
    expect(orthodoxEaster(2025)).toEqual([2025, 4, 20]);
    expect(orthodoxEaster(2026)).toEqual([2026, 4, 12]);
    expect(orthodoxEaster(2027)).toEqual([2027, 5, 2]);
  });

  it('derives movable holidays from Easter', () => {
    expect(polandHolidays(2026).find((h) => h.name === 'Easter Monday')?.date).toBe('2026-04-06');
    expect(polandHolidays(2026).find((h) => h.name === 'Corpus Christi')?.date).toBe('2026-06-04');
    expect(ukraineHolidays(2026).find((h) => h.name === 'Orthodox Easter Monday')?.date).toBe(
      '2026-04-13',
    );
  });

  it('lists unique real dates for every requested year', () => {
    const all = holidaysFor('PL', [2025, 2026, 2027]);
    expect(new Set(all.map((h) => h.date)).size).toBe(all.length);
    expect(all.every((h) => !Number.isNaN(Date.parse(h.date)))).toBe(true);
  });
});
