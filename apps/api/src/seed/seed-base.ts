import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '@helpdesk/core';
import type { Language } from '@helpdesk/shared';
import { holidaysFor } from './holidays';
import { HOLIDAY_YEARS, TEAM_SEEDS } from './profiles';
import type { Rng } from './rng';
import { FIRST_NAMES, LAST_NAMES } from './text-data';

export const SEED_DOMAIN = 'helpdesk.test';

export type SeededTeam = {
  readonly key: string;
  readonly id: string;
  readonly timeZone: string;
  readonly workStartMin: number;
  readonly workEndMin: number;
  readonly mailbox: string;
  readonly holidays: readonly string[];
};

export type SeededAgent = {
  readonly id: string;
  readonly teamKey: string;
  readonly teamId: string;
  readonly limit: number;
  readonly languages: readonly Language[];
  readonly onShift: boolean;
  readonly email: string;
};

export type SeededBase = {
  readonly teams: readonly SeededTeam[];
  readonly agents: readonly SeededAgent[];
};

const personName = (i: number): string =>
  `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[Math.floor(i / FIRST_NAMES.length + i * 7) % LAST_NAMES.length]}`;

/** Teams, holidays, mailboxes, routing rules, the admin, one lead per team and the agents. */
export const seedBase = async (
  tx: Tx,
  o: { readonly rng: Rng; readonly passwordHash: string; readonly agentsPerTeam: number },
): Promise<SeededBase> => {
  const teams: SeededTeam[] = [];
  for (const t of TEAM_SEEDS) {
    const id = randomUUID();
    const holidays = holidaysFor(t.country, HOLIDAY_YEARS).map((h) => h.date);
    await tx.team.create({
      data: {
        id,
        name: t.name,
        timeZone: t.timeZone,
        workdays: [1, 2, 3, 4, 5],
        workStartMin: t.workStartMin,
        workEndMin: t.workEndMin,
        defaultLanguage: t.defaultLanguage,
        holidays: {
          create: holidaysFor(t.country, HOLIDAY_YEARS).map((h) => ({
            date: new Date(`${h.date}T00:00:00Z`),
            name: h.name,
          })),
        },
      },
    });
    await tx.mailbox.create({
      data: { address: `${t.mailbox}@${SEED_DOMAIN}`, defaultTeamId: id },
    });
    teams.push({
      key: t.key,
      id,
      timeZone: t.timeZone,
      workStartMin: t.workStartMin,
      workEndMin: t.workEndMin,
      mailbox: `${t.mailbox}@${SEED_DOMAIN}`,
      holidays,
    });
  }
  const teamId = (key: string): string => teams.find((t) => t.key === key)?.id ?? '';
  await tx.routingRule.createMany({
    data: [
      {
        position: 10,
        subjectKeywords: ['invoice', 'refund', 'payment', 'billing', 'charge'],
        teamId: teamId('billing-kyiv'),
      },
      { position: 20, language: 'pl', teamId: teamId('support-warsaw') },
      {
        position: 30,
        subjectKeywords: ['crash', 'error', 'bug', 'server', 'network'],
        teamId: teamId('tech-warsaw'),
      },
      {
        position: 40,
        subjectKeywords: ['urgent', 'asap'],
        teamId: teamId('support-kyiv'),
        priority: 'high',
      },
    ],
  });

  await tx.user.create({
    data: {
      email: `admin@${SEED_DOMAIN}`,
      name: 'Admin User',
      passwordHash: o.passwordHash,
      role: 'admin',
      languages: ['en'],
      ticketLimit: 0,
    },
  });
  for (const t of TEAM_SEEDS) {
    await tx.user.create({
      data: {
        email: `lead.${t.key}@${SEED_DOMAIN}`,
        name: `Lead ${t.name}`,
        passwordHash: o.passwordHash,
        languages: [...t.languages],
        ticketLimit: 0,
        memberships: { create: { teamId: teamId(t.key), role: 'lead' } },
      },
    });
  }

  const agents: SeededAgent[] = [];
  let n = 0;
  for (const t of TEAM_SEEDS) {
    for (let k = 0; k < o.agentsPerTeam; k += 1) {
      n += 1;
      const id = randomUUID();
      const email = `agent${String(n).padStart(2, '0')}@${SEED_DOMAIN}`;
      const languages: Language[] = t.languages.filter(
        (l) => l === 'en' || k % 2 === 0 || l !== 'de',
      );
      const limit = o.rng.int(15, 30);
      const onShift = k % 10 !== 9; // every tenth agent is off shift
      await tx.user.create({
        data: {
          id,
          email,
          name: personName(n),
          passwordHash: o.passwordHash,
          languages,
          ticketLimit: limit,
          onShift,
          memberships: { create: { teamId: teamId(t.key), role: 'agent' } },
        },
      });
      agents.push({ id, teamKey: t.key, teamId: teamId(t.key), limit, languages, onShift, email });
    }
  }
  return { teams, agents };
};

export const truncateAll = async (db: Db): Promise<void> => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE notifications, refresh_tokens, surveys, ticket_access_tokens, sla_pauses, ticket_events,
      attachments, outbound_emails, inbound_messages, messages, jobs, tickets, customers, routing_rules,
      mailboxes, team_holidays, team_members, teams, users, seed_runs RESTART IDENTITY CASCADE`);
  await db.$executeRawUnsafe('ALTER SEQUENCE ticket_number_seq RESTART WITH 100000');
  await db.$executeRawUnsafe('UPDATE app_clock SET offset_ms = 0, generation = generation + 1');
};
