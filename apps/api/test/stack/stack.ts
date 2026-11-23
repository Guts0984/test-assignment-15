import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createDb, type Db } from '@helpdesk/core';
import { client, type Client } from '../attacker/client';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const root = resolve(__dirname, '../../../..');

export const urls = {
  base: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
  api1: process.env.E2E_API_1_URL ?? 'http://localhost:3101',
  api2: process.env.E2E_API_2_URL ?? 'http://localhost:3102',
  stub: process.env.E2E_MAIL_STUB_URL ?? 'http://localhost:8025',
};
export const secrets = {
  controlToken: process.env.TEST_CONTROL_TOKEN ?? '',
  staffPassword: process.env.SEED_STAFF_PASSWORD ?? '',
  mailDomain: process.env.MAIL_DOMAIN ?? 'helpdesk.test',
};

let sharedDb: Db | null = null;
export const stackDb = (): Db => {
  sharedDb ??= createDb(process.env.STACK_DATABASE_URL ?? '');
  return sharedDb;
};
export const uniq = (p: string): string => `${p}-${randomUUID().slice(0, 8)}`;

const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml'];
export const dc = async (...args: string[]): Promise<string> =>
  (await run('docker', [...compose, ...args], { cwd: root, maxBuffer: 20_000_000 })).stdout;
export const workerContainers = async (): Promise<string[]> =>
  (await dc('ps', '-q', 'worker')).split('\n').filter((s) => s !== '');
export const flushRedis = async (): Promise<void> =>
  void (await dc('exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'));

export const eventually = async <T>(
  fn: () => Promise<T | false | null | undefined>,
  ms = 60_000,
  label = 'condition',
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => false as const);
    if (v !== false && v !== null && v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${label} not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

export const loginVia = async (
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ client: Client; token: string; userId: string }> => {
  const r = await client({ baseUrl }).post('/api/v1/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${r.text}`);
  const j = r.json as { accessToken: string; user: { id: string } };
  return {
    client: client({ baseUrl, auth: { bearer: j.accessToken } }),
    token: j.accessToken,
    userId: j.user.id,
  };
};

export const adminLogin = () => loginVia(urls.base, 'admin@helpdesk.test', secrets.staffPassword);

export const setClock = async (body: { advanceMs?: number; offsetMs?: number }): Promise<void> => {
  const r = await client({ baseUrl: urls.base }).post('/api/v1/test/clock', body, {
    headers: { 'x-test-control-token': secrets.controlToken },
  });
  if (r.status !== 200) throw new Error(`clock failed ${r.status} ${r.text}`);
};

export type TestTeam = {
  teamId: string;
  mailbox: string;
  agents: { id: string; email: string; token: string; client: Client }[];
  lead: { id: string; email: string; token: string; client: Client };
};

/** Builds an isolated team through the real admin API: team, mailbox, agents (on shift) and a lead. */
export const createTeam = async (o: {
  agents: number;
  limit: number;
  timeZone?: string;
  hours?: [string, string];
  languages?: string[];
}): Promise<TestTeam> => {
  const admin = await adminLogin();
  const name = uniq('Stack');
  const team = (
    await admin.client.post('/api/v1/admin/teams', {
      name,
      defaultLanguage: 'en',
      timeZone: o.timeZone ?? 'Europe/Kyiv',
      workdays: [1, 2, 3, 4, 5, 6, 7],
      workStart: o.hours?.[0] ?? '00:00',
      workEnd: o.hours?.[1] ?? '24:00',
    })
  ).json as { id: string };
  const mailbox = `${uniq('box')}@${secrets.mailDomain}`.toLowerCase();
  const mb = await admin.client.post('/api/v1/admin/mailboxes', {
    address: mailbox,
    defaultTeamId: team.id,
  });
  if (mb.status !== 201) throw new Error(`mailbox failed ${mb.text}`);
  const pw = 'Stack-Passw0rd!';
  const make = async (role: 'agent' | 'lead') => {
    const email = `${uniq(role)}@${secrets.mailDomain}`;
    const r = await admin.client.post('/api/v1/admin/agents', {
      email,
      name: `${role} ${email.slice(0, 8)}`,
      password: pw,
      ticketLimit: role === 'lead' ? 0 : o.limit,
      languages: o.languages ?? ['en', 'uk', 'pl', 'de'],
      memberships: [{ teamId: team.id, role }],
      active: true,
    });
    if (r.status !== 201) throw new Error(`agent failed ${r.status} ${r.text}`);
    const l = await loginVia(urls.base, email, pw);
    if (role === 'agent') await l.client.put('/api/v1/me/shift', { onShift: true });
    return { id: l.userId, email, token: l.token, client: l.client };
  };
  const agents = await Promise.all(Array.from({ length: o.agents }, () => make('agent')));
  return { teamId: team.id, mailbox, agents, lead: await make('lead') };
};

export type InjectInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  messageId?: string;
  references?: string[];
  headers?: Record<string, string>;
};
export const inject = async (
  m: InjectInput,
): Promise<{ messageId: string; deliveries: { status: number }[] }> => {
  const r = await fetch(`${urls.stub}/api/inbound`, { method: 'POST', body: JSON.stringify(m) });
  if (!r.ok) throw new Error(`inject failed ${r.status} ${await r.text()}`);
  return (await r.json()) as { messageId: string; deliveries: { status: number }[] };
};

export type StubMail = {
  subject: string;
  to: string[];
  messageId: string | null;
  headers: Record<string, string>;
  text: string;
};
export const stubMail = async (q: { to?: string; limit?: number } = {}): Promise<StubMail[]> => {
  const u = new URL('/api/messages', urls.stub);
  if (q.to !== undefined) u.searchParams.set('to', q.to);
  u.searchParams.set('limit', String(q.limit ?? 5000));
  return (await (await fetch(u)).json()) as StubMail[];
};
export const setChaos = async (enabled: boolean): Promise<void> =>
  void (await fetch(`${urls.stub}/api/chaos`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  }));

export const customersOf = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}@customer.test`);
