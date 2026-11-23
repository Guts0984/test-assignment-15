import { inTx, type Db, type Tx } from '@helpdesk/core';
import type { Clock, Language } from '@helpdesk/shared';
import { buildLiveSet, type LiveSet } from './live-tickets';
import { SEED_SIZES, type SeedProfileName } from './profiles';
import { createRng } from './rng';
import { seedBase, truncateAll } from './seed-base';
import { md5Uuid, seedHistoric } from './seed-bulk';

const LIVE_RNG_SEED = 1234;

export type SeedOptions = {
  readonly profile: SeedProfileName | 'none';
  readonly randomSeed: number;
  readonly reset: boolean;
  readonly passwordHash: string;
  readonly clock: Clock;
  readonly warningRatio: number;
  readonly log?: (line: string) => void;
};

export type SeedOutcome =
  | { readonly status: 'skipped'; readonly reason: 'profile-none' | 'already-seeded' }
  | {
      readonly status: 'seeded';
      readonly profile: SeedProfileName;
      readonly liveSet: { readonly tickets: number; readonly messages: number };
      readonly finishedAt: Date;
    };

const insertLive = async (tx: Tx, live: LiveSet): Promise<void> => {
  const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
      items.slice(i * size, (i + 1) * size),
    );

  for (const part of chunk(live.tickets, 500)) {
    await tx.ticket.createMany({
      data: part.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        language: t.language,
        source: 'email',
        teamId: t.teamId,
        customerId: t.customerId,
        assigneeId: t.assigneeId,
        mailboxAddress: t.mailboxAddress,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        queuedAt: t.queuedAt,
        firstRespondedAt: t.firstRespondedAt,
        resolvedAt: t.resolvedAt,
        lastCustomerMsgAt: t.lastCustomerMsgAt,
        lastPublicReplyAt: t.lastPublicReplyAt,
        firstResponseDueAt: t.sla.firstResponseDueAt,
        firstResponseWarnAt: t.sla.firstResponseWarnAt,
        resolutionDueAt: t.sla.resolutionDueAt,
        resolutionWarnAt: t.sla.resolutionWarnAt,
        slaPaused: t.sla.paused,
        nextDueAt: t.nextDueAt,
        firstResponseBreached: t.firstResponseBreached,
        resolutionBreached: t.resolutionBreached,
        messageSeq: t.messageSeq,
      })),
    });
  }
  for (const part of chunk(live.messages, 2000)) {
    await tx.message.createMany({
      data: part.map((m) => ({
        ticketId: m.ticketId,
        seq: m.seq,
        kind: m.kind,
        direction: m.direction,
        authorKind: m.authorKind,
        authorUserId: m.authorUserId,
        body: m.body,
        createdAt: m.createdAt,
        releasedAt: m.releasedAt,
      })),
    });
  }
  for (const part of chunk(live.events, 2000)) {
    await tx.ticketEvent.createMany({
      data: part.map((e) => ({
        ticketId: e.ticketId,
        type: e.type,
        actorKind: e.actorKind,
        actorUserId: e.actorUserId,
        data: e.data as object,
        createdAt: e.createdAt,
      })),
    });
  }
  await tx.slaPause.createMany({
    data: live.pauses.map((p) => ({
      ticketId: p.ticketId,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
    })),
  });
  for (const part of chunk(live.jobs, 1000)) {
    await tx.job.createMany({
      data: part.map((j) => ({
        kind: j.kind,
        ref: j.ref,
        dedupeKey: j.dedupeKey,
        runAt: j.runAt,
        status: j.status,
        payload: j.payload as object,
        createdAt: j.runAt,
        completedAt: j.status === 'done' ? j.runAt : null,
      })),
    });
  }
};

/** Idempotent seed: a `seed_runs` marker row makes later starts skip it; `reset` re-creates everything. */
export const runSeed = async (db: Db, o: SeedOptions): Promise<SeedOutcome> => {
  if (o.profile === 'none') return { status: 'skipped', reason: 'profile-none' };
  const log = o.log ?? ((): void => undefined);
  const existing = await db.seedRun.findUnique({ where: { id: 1 } });
  if (existing !== null && !o.reset) return { status: 'skipped', reason: 'already-seeded' };
  if (o.reset) await truncateAll(db);

  const sizes = SEED_SIZES[o.profile];
  const rng = createRng(o.randomSeed);
  const started = Date.now();

  return inTx(
    db,
    async (tx) => {
      const base = await seedBase(tx, {
        rng,
        passwordHash: o.passwordHash,
        agentsPerTeam: sizes.agentsPerTeam,
      });
      log(`base data created (${base.agents.length} agents)`);
      const historicNow = o.clock.now();
      const liveCount = sizes.liveActive + sizes.liveResolved;
      // Live messages are built first (pure) only to know how many there are; they are inserted last.
      const probe = await seedHistoricWithLive(tx, {
        sizes,
        now: historicNow,
        rng,
        base,
        liveCount,
        warningRatio: o.warningRatio,
        log,
      });
      log(`seed finished in ${Math.round((Date.now() - started) / 1000)} s`);
      return probe;
    },
    { maxWaitMs: 60_000, timeoutMs: 3 * 3_600_000 },
  ).then(async (outcome) => {
    await db.$executeRawUnsafe('ANALYZE');
    return outcome;
  });
};

type Ctx = Parameters<typeof seedHistoric>[1] & {
  readonly warningRatio: number;
  readonly log: (line: string) => void;
};

const seedHistoricWithLive = async (
  tx: Tx,
  c: Omit<Ctx, 'liveMessageTarget'>,
): Promise<SeedOutcome> => {
  const { sizes, base } = c;
  // First pass builds the live set only to learn its message count; the real one is rebuilt at the end
  // so every timer is relative to the moment the seed actually finishes.
  const dry = buildLiveSet({
    now: c.now,
    rng: createRng(LIVE_RNG_SEED),
    teams: base.teams.map((t) => ({ id: t.id, mailbox: t.mailbox, calendar: calendarOf(t) })),
    agents: base.agents,
    customerIds: [md5Uuid('cust:1')],
    subjects: ['x'],
    bodies: ['y'],
    active: sizes.liveActive,
    breachSoon: sizes.breachSoon,
    warnSoon: sizes.warnSoon,
    resolved: sizes.liveResolved,
    warningRatio: c.warningRatio,
  });
  // Same rng seed and shape as the real build below, so the message count is identical.
  const liveMessageTarget = dry.messages.length;
  const { bodies, subjects } = await seedHistoric(tx, { ...c, liveMessageTarget });
  c.log('historic data created');

  const finishNow = new Date();
  const liveCustomers = Array.from({ length: 5000 }, (_, i) =>
    md5Uuid(`cust:${1 + ((i * 37) % sizes.customers)}`),
  );
  const live = buildLiveSet({
    now: finishNow,
    rng: createRng(LIVE_RNG_SEED),
    teams: base.teams.map((t) => ({ id: t.id, mailbox: t.mailbox, calendar: calendarOf(t) })),
    agents: base.agents,
    customerIds: liveCustomers,
    subjects,
    bodies,
    active: sizes.liveActive,
    breachSoon: sizes.breachSoon,
    warnSoon: sizes.warnSoon,
    resolved: sizes.liveResolved,
    warningRatio: c.warningRatio,
  });
  await insertLive(tx, live);

  const counted = await tx.$queryRawUnsafe<{ count: bigint }[]>(
    'SELECT count(*)::bigint AS count FROM messages',
  );
  const total = Number(counted[0]?.count ?? 0);
  if (total !== sizes.messages)
    throw new Error(`Seed produced ${total} messages, expected ${sizes.messages}`);
  await tx.$executeRawUnsafe(
    `UPDATE users u SET last_assigned_at = x.last
       FROM (SELECT assignee_id, max(created_at) AS last FROM tickets
              WHERE assignee_id IS NOT NULL AND closed_at IS NULL GROUP BY assignee_id) x
      WHERE x.assignee_id = u.id`,
  );
  const finishedAt = new Date();
  await tx.seedRun.create({
    data: {
      id: 1,
      profile: sizes.tickets === 500_000 ? 'full' : 'small',
      randomSeed: 0,
      finishedAt,
    },
  });
  return {
    status: 'seeded',
    profile: sizes.tickets === 500_000 ? 'full' : 'small',
    liveSet: { tickets: live.tickets.length, messages: live.messages.length },
    finishedAt,
  };
};

const calendarOf = (t: {
  timeZone: string;
  workStartMin: number;
  workEndMin: number;
  holidays: readonly string[];
}) => ({
  kind: 'hours' as const,
  timeZone: t.timeZone,
  workdays: [1, 2, 3, 4, 5],
  startMinute: t.workStartMin,
  endMinute: t.workEndMin,
  holidays: t.holidays,
});

export type { Language };
