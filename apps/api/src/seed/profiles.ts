export type SeedProfileName = 'full' | 'small';

export type SeedSizes = {
  readonly customers: number;
  readonly tickets: number;
  readonly messages: number;
  /** Open tickets with running SLA timers, inserted last relative to the seed finishing moment. */
  readonly liveActive: number;
  /** Of those: urgent tickets whose first response breaches 1-10 minutes after start. */
  readonly breachSoon: number;
  /** Of those: urgent tickets whose resolution warning fires within about 10 minutes. */
  readonly warnSoon: number;
  /** Recently resolved tickets waiting for auto-close. */
  readonly liveResolved: number;
  readonly agentsPerTeam: number;
  readonly historyDays: number;
};

export const SEED_SIZES: Readonly<Record<SeedProfileName, SeedSizes>> = {
  full: {
    customers: 200_000,
    tickets: 500_000,
    messages: 3_000_000,
    liveActive: 2_000,
    breachSoon: 150,
    warnSoon: 100,
    liveResolved: 60,
    agentsPerTeam: 20,
    historyDays: 730,
  },
  small: {
    customers: 2_000,
    tickets: 5_000,
    messages: 30_000,
    liveActive: 200,
    breachSoon: 15,
    warnSoon: 10,
    liveResolved: 10,
    agentsPerTeam: 20,
    historyDays: 730,
  },
};

export type TeamSeed = {
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  readonly country: 'UA' | 'PL';
  readonly defaultLanguage: 'en' | 'uk' | 'pl' | 'de';
  readonly languages: readonly ('en' | 'uk' | 'pl' | 'de')[];
  readonly mailbox: string;
  readonly workStartMin: number;
  readonly workEndMin: number;
};

/** Four teams in two time zones. */
export const TEAM_SEEDS: readonly TeamSeed[] = [
  {
    key: 'support-kyiv',
    name: 'Support Kyiv',
    timeZone: 'Europe/Kyiv',
    country: 'UA',
    defaultLanguage: 'en',
    languages: ['en', 'uk'],
    mailbox: 'support',
    workStartMin: 540,
    workEndMin: 1080,
  },
  {
    key: 'billing-kyiv',
    name: 'Billing Kyiv',
    timeZone: 'Europe/Kyiv',
    country: 'UA',
    defaultLanguage: 'en',
    languages: ['en', 'uk'],
    mailbox: 'billing',
    workStartMin: 540,
    workEndMin: 1080,
  },
  {
    key: 'support-warsaw',
    name: 'Support Warsaw',
    timeZone: 'Europe/Warsaw',
    country: 'PL',
    defaultLanguage: 'en',
    languages: ['en', 'pl', 'de'],
    mailbox: 'pl',
    workStartMin: 480,
    workEndMin: 1020,
  },
  {
    key: 'tech-warsaw',
    name: 'Tech Warsaw',
    timeZone: 'Europe/Warsaw',
    country: 'PL',
    defaultLanguage: 'en',
    languages: ['en', 'pl'],
    mailbox: 'tech',
    workStartMin: 480,
    workEndMin: 1020,
  },
];

export const HOLIDAY_YEARS = [2025, 2026, 2027] as const;
