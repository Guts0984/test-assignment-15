import { randomUUID } from 'node:crypto';
import { createDb, createDbClock, upsertJob, type Db, type TicketConfig } from '@helpdesk/core';
import { systemClock } from '@helpdesk/shared';
import { Redis } from 'ioredis';
import { SMTPServer } from 'smtp-server';
import mailparser from 'mailparser';
import { startWorkerRuntime, type RuntimeConfig, type WorkerRuntime } from '../src/runtime/runtime';

export const dbUrl = (): string => process.env.DATABASE_URL ?? '';
export const redisUrl = (): string => process.env.REDIS_URL ?? '';
export const testDb = (): Db => createDb(dbUrl());
export const uniq = (p: string): string => `${p}-${randomUUID().slice(0, 8)}`;

export const ticketConfig: TicketConfig = {
  warningRatio: 0.8,
  undoSeconds: 10,
  linkTtlDays: 30,
  surveyTtlDays: 7,
  autoCloseHours: 72,
  mailDomain: 'helpdesk.test',
  publicBaseUrl: 'http://localhost:8080',
  maxAttachmentBytes: 10 * 1024 * 1024,
};

export type Sink = {
  readonly port: number;
  /** Message-IDs delivered successfully, in order. */
  readonly delivered: string[];
  readonly attempts: () => number;
  readonly failWhen: (fn: (attempt: number) => 'transient' | 'permanent' | null) => void;
  readonly stop: () => Promise<void>;
};

/** A tiny SMTP sink that records what really arrived; the single source for "sent exactly once" assertions. */
export const startSink = async (): Promise<Sink> => {
  const state = { attempts: 0, fail: (_n: number): 'transient' | 'permanent' | null => null };
  const delivered: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData: (stream, _s, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        state.attempts += 1;
        const f = state.fail(state.attempts);
        if (f !== null)
          return cb(
            Object.assign(new Error(f === 'transient' ? '451 temporary' : '550 rejected'), {
              responseCode: f === 'transient' ? 451 : 550,
            }),
          );
        void mailparser.simpleParser(Buffer.concat(chunks)).then((p) => {
          delivered.push(String(p.messageId));
          cb();
        });
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  return {
    port,
    delivered,
    attempts: () => state.attempts,
    failWhen: (fn) => {
      state.fail = fn;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
};

export const runtimeConfig = (
  sinkPort: number,
  prefix: string,
  over: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  databaseUrl: dbUrl(),
  redisUrl: redisUrl(),
  queuePrefix: prefix,
  testClock: false,
  smtp: { host: '127.0.0.1', port: sinkPort, fromName: 'Helpdesk' },
  mailDomain: 'helpdesk.test',
  concurrency: 5,
  reconcileIntervalMs: 200,
  reconcileHorizonMs: 600_000,
  jobMaxAttempts: 6,
  backoffBaseMs: 200,
  backoffMaxMs: 2000,
  outboundLeaseMs: 5000,
  ticket: ticketConfig,
  ...over,
});

export const startWorker = (
  sinkPort: number,
  prefix: string,
  over: Partial<RuntimeConfig> = {},
): Promise<WorkerRuntime> => startWorkerRuntime(runtimeConfig(sinkPort, prefix, over));

export const eventually = async <T>(
  fn: () => Promise<T | false | null | undefined>,
  ms = 20_000,
  label = 'condition',
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== false && v !== null && v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${label} not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

export const makeTeam = async (db: Db, o: { agents?: number; limit?: number } = {}) => {
  const team = await db.team.create({
    data: {
      name: uniq('team'),
      timeZone: 'Europe/Kyiv',
      workdays: [1, 2, 3, 4, 5],
      workStartMin: 0,
      workEndMin: 1440,
    },
  });
  const mailbox = `${uniq('box')}@helpdesk.test`;
  await db.mailbox.create({ data: { address: mailbox, defaultTeamId: team.id } });
  const agents = await Promise.all(
    Array.from({ length: o.agents ?? 0 }, () =>
      db.user.create({
        data: {
          email: `${uniq('agent')}@test.example`,
          name: 'Agent',
          passwordHash: 'x',
          ticketLimit: o.limit ?? 20,
          onShift: true,
          memberships: { create: { teamId: team.id, role: 'agent' } },
        },
      }),
    ),
  );
  const lead = await db.user.create({
    data: {
      email: `${uniq('lead')}@test.example`,
      name: 'Lead',
      passwordHash: 'x',
      ticketLimit: 0,
      memberships: { create: { teamId: team.id, role: 'lead' } },
    },
  });
  return { team, mailbox, agents, lead };
};

export const dropInbound = async (
  db: Db,
  mailbox: string,
  from: string,
  subject: string,
  extra: { inReplyTo?: string } = {},
): Promise<string> => {
  const messageId = `${randomUUID()}@sender.test`;
  const raw = Buffer.from(
    [
      `From: ${from}`,
      `To: ${mailbox}`,
      `Subject: ${subject}`,
      `Message-ID: <${messageId}>`,
      ...(extra.inReplyTo === undefined ? [] : [`In-Reply-To: <${extra.inReplyTo}>`]),
      'MIME-Version: 1.0',
      'Content-Type: text/plain',
      '',
      'help me',
      '',
    ].join('\r\n'),
  );
  const rows = await db.$queryRaw<
    { id: string }[]
  >`INSERT INTO inbound_messages (mailbox_address, rfc_message_id, raw) VALUES (${mailbox}, ${messageId}, ${raw}) RETURNING id`;
  const id = rows[0]?.id ?? '';
  await upsertJob(db, {
    kind: 'inbound_process',
    ref: id,
    dedupeKey: `inbound:${id}`,
    runAt: new Date(),
    now: new Date(),
    payload: { inboundId: id },
  });
  return id;
};

export const flushRedis = async (): Promise<void> => {
  const r = new Redis(redisUrl());
  await r.flushall();
  r.disconnect();
};

export { createDbClock, systemClock };
