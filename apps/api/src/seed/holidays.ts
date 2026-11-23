/** Western (Gregorian) Easter Sunday, anonymous algorithm. Returns [year, month, day]. */
export const westernEaster = (year: number): readonly [number, number, number] => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [year, month, day];
};

/** Orthodox Easter Sunday in the Gregorian calendar (Julian computus + 13 days, valid 1900-2099). */
export const orthodoxEaster = (year: number): readonly [number, number, number] => {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = Date.UTC(year, month - 1, day);
  const greg = new Date(julian + 13 * 86_400_000);
  return [greg.getUTCFullYear(), greg.getUTCMonth() + 1, greg.getUTCDate()];
};

export type Holiday = { readonly date: string; readonly name: string };

const iso = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const plusDays = (ymd: readonly [number, number, number], days: number): string => {
  const t = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]) + days * 86_400_000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

export const ukraineHolidays = (year: number): readonly Holiday[] => {
  const easter = orthodoxEaster(year);
  return [
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: iso(year, 3, 8), name: "International Women's Day" },
    { date: plusDays(easter, 1), name: 'Orthodox Easter Monday' },
    { date: iso(year, 5, 1), name: 'Labour Day' },
    { date: iso(year, 5, 9), name: 'Victory Day' },
    { date: plusDays(easter, 50), name: 'Trinity Monday' },
    { date: iso(year, 6, 28), name: 'Constitution Day' },
    { date: iso(year, 8, 24), name: 'Independence Day' },
    { date: iso(year, 10, 14), name: 'Defenders Day' },
    { date: iso(year, 12, 25), name: 'Christmas Day' },
  ];
};

export const polandHolidays = (year: number): readonly Holiday[] => {
  const easter = westernEaster(year);
  return [
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: iso(year, 1, 6), name: 'Epiphany' },
    { date: plusDays(easter, 1), name: 'Easter Monday' },
    { date: iso(year, 5, 1), name: 'Labour Day' },
    { date: iso(year, 5, 3), name: 'Constitution Day' },
    { date: plusDays(easter, 60), name: 'Corpus Christi' },
    { date: iso(year, 8, 15), name: 'Assumption Day' },
    { date: iso(year, 11, 1), name: "All Saints' Day" },
    { date: iso(year, 11, 11), name: 'Independence Day' },
    { date: iso(year, 12, 24), name: 'Christmas Eve' },
    { date: iso(year, 12, 25), name: 'Christmas Day' },
    { date: iso(year, 12, 26), name: 'Second Day of Christmas' },
  ];
};

export const holidaysFor = (country: 'UA' | 'PL', years: readonly number[]): readonly Holiday[] =>
  years.flatMap((y) => (country === 'UA' ? ukraineHolidays(y) : polandHolidays(y)));
