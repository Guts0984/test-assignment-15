import { createDb, type Db } from '@helpdesk/core';
import { env, type Env } from '../../src/config/env';
import { createApiApp, type ApiApp } from '../../src/app.factory';
import { hashPassword } from '../../src/infra/password';
import { client, type Client } from '../attacker/client';

export type RunningApi = {
  readonly app: ApiApp;
  readonly url: string;
  readonly port: number;
  readonly env: Env;
  readonly close: () => Promise<void>;
};

/** Starts the real API on an ephemeral port with the same configuration as production (plus the test clock). */
export const startApi = async (override: Partial<Env> = {}): Promise<RunningApi> => {
  const e = Object.freeze({ ...env, ...override }) as Env;
  const app = await createApiApp(e);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    env: e,
    close: () => app.close(),
  };
};

let sharedDb: Db | null = null;
export const testDb = (): Db => {
  sharedDb ??= createDb(env.DATABASE_URL);
  return sharedDb;
};

export const uniq = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 10)}`;

export const PASSWORD = 'Test-Passw0rd!';
let cachedHash: string | null = null;
const passwordHash = async (): Promise<string> => {
  cachedHash ??= await hashPassword(PASSWORD, { memoryKiB: 4096, timeCost: 1 });
  return cachedHash;
};

export const createTeamRow = async (
  db: Db,
  over: { timeZone?: string; name?: string } = {},
): Promise<{ id: string }> =>
  db.team.create({
    data: {
      name: over.name ?? uniq('team'),
      timeZone: over.timeZone ?? 'Europe/Kyiv',
      workdays: [1, 2, 3, 4, 5],
      workStartMin: 540,
      workEndMin: 1080,
    },
    select: { id: true },
  });

export type TestUser = { readonly id: string; readonly email: string };

export const createUserRow = async (
  db: Db,
  o: {
    role?: 'admin' | 'staff';
    teams?: readonly { teamId: string; role: 'agent' | 'lead' }[];
    limit?: number;
    onShift?: boolean;
    active?: boolean;
  } = {},
): Promise<TestUser> => {
  const email = `${uniq('user')}@test.example`;
  const u = await db.user.create({
    data: {
      email,
      name: 'Test User',
      passwordHash: await passwordHash(),
      role: o.role ?? 'staff',
      ticketLimit: o.limit ?? 20,
      onShift: o.onShift ?? true,
      isActive: o.active ?? true,
      memberships: { create: (o.teams ?? []).map((t) => ({ teamId: t.teamId, role: t.role })) },
    },
    select: { id: true, email: true },
  });
  return u;
};

export type LoggedIn = {
  readonly user: TestUser;
  readonly client: Client;
  readonly accessToken: string;
  readonly cookie: string;
};

export const login = async (
  api: RunningApi,
  user: TestUser,
  password = PASSWORD,
): Promise<LoggedIn> => {
  const anon = client({ baseUrl: api.url });
  const r = await anon.post('/api/v1/auth/login', { email: user.email, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  const accessToken = (r.json as { accessToken: string }).accessToken;
  const setCookie = r.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return {
    user,
    client: client({ baseUrl: api.url, auth: { bearer: accessToken } }),
    accessToken,
    cookie,
  };
};

export const setTestClock = async (
  api: RunningApi,
  body: { offsetMs?: number; advanceMs?: number },
): Promise<void> => {
  const r = await client({ baseUrl: api.url }).post('/api/v1/test/clock', body, {
    headers: { 'x-test-control-token': env.TEST_CONTROL_TOKEN ?? '' },
  });
  if (r.status !== 200) throw new Error(`clock failed: ${r.status} ${r.text}`);
};
