import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from '../attacker/client';
import {
  createTeamRow,
  createUserRow,
  login,
  startApi,
  testDb,
  type LoggedIn,
  type RunningApi,
} from '../helpers/api';

type Operation = { method: string; path: string; access: string; hasBody: boolean };

let api: RunningApi;
let defaultProfile: RunningApi;
let ops: Operation[] = [];
let admin: LoggedIn;
let agent: LoggedIn;
const db = testDb();
const FAKE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const fill = (path: string): string =>
  path.replace(/\{[^}]+\}/g, (m) => (m === '{id}' ? FAKE_ID : FAKE_ID));

beforeAll(async () => {
  api = await startApi();
  defaultProfile = await startApi({ TEST_CLOCK_ENABLED: false });
  const doc = (await client({ baseUrl: api.url }).get('/docs/openapi.json')).json as {
    paths: Record<string, Record<string, { 'x-access'?: string; requestBody?: unknown }>>;
  };
  ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      access: op['x-access'] ?? 'MISSING',
      hasBody: op.requestBody !== undefined,
    })),
  );
  const team = await createTeamRow(db);
  admin = await login(api, await createUserRow(db, { role: 'admin' }));
  agent = await login(
    api,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] }),
  );
});
afterAll(async () => {
  await Promise.all([api.close(), defaultProfile.close()]);
});

const call = (c: ReturnType<typeof client>, o: Operation) =>
  c.request({ method: o.method, path: fill(o.path), ...(o.hasBody ? { body: {} } : {}) });

describe('route table (every documented operation)', () => {
  it('documents the operations and declares an access level on every single one', () => {
    expect(ops.length).toBeGreaterThan(20);
    expect(ops.filter((o) => o.access === 'MISSING')).toEqual([]);
  });

  it('protected routes return 401 without credentials, in the shared error format', async () => {
    const anon = client({ baseUrl: api.url });
    for (const o of ops.filter((x) => x.access !== 'public')) {
      const r = await call(anon, o);
      expect(r.status, `${o.method} ${o.path}`).toBe(401);
      const code = (r.json as { error: { code: string } }).error.code;
      expect(code, `${o.method} ${o.path}`).toMatch(/^(UNAUTHORIZED|LINK_INVALID)$/);
    }
  });

  it('admin routes return 403 for an agent token and are reachable for an admin', async () => {
    for (const o of ops.filter((x) => x.access === 'admin')) {
      const forbidden = await call(agent.client, o);
      expect(forbidden.status, `agent ${o.method} ${o.path}`).toBe(403);
      expect((forbidden.json as { error: { code: string } }).error.code).toBe('FORBIDDEN');
      const allowed = await call(admin.client, o);
      expect([401, 403], `admin ${o.method} ${o.path}`).not.toContain(allowed.status);
      expect(allowed.status, `admin ${o.method} ${o.path}`).toBeLessThan(500);
    }
  });

  it('customer-link routes reject staff tokens and invalid links', async () => {
    for (const o of ops.filter((x) => x.access === 'customer')) {
      expect((await call(admin.client, o)).status, `${o.method} ${o.path}`).toBe(401);
      const bad = client({ baseUrl: api.url, auth: { ticketToken: 'x'.repeat(43) } });
      expect((await call(bad, o)).status, `${o.method} ${o.path}`).toBe(401);
    }
  });

  it('staff routes work for agents and never answer 401/403 to them', async () => {
    for (const o of ops.filter((x) => x.access === 'staff')) {
      const r = await call(agent.client, o);
      expect([401, 403], `${o.method} ${o.path}`).not.toContain(r.status);
      expect(r.status).toBeLessThan(500);
    }
  });

  it('the test clock route does not exist in the default profile (flag off)', async () => {
    const r = await client({ baseUrl: defaultProfile.url }).post(
      '/api/v1/test/clock',
      { advanceMs: 1000 },
      {
        headers: { 'x-test-control-token': api.env.TEST_CONTROL_TOKEN ?? '' },
      },
    );
    expect(r.status).toBe(404);
    const doc = (await client({ baseUrl: defaultProfile.url }).get('/docs/openapi.json')).json as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths).some((p) => p.startsWith('/test'))).toBe(false);
  });

  it('unknown routes and unsupported methods use the shared error body, never an HTML page', async () => {
    const anon = client({ baseUrl: api.url });
    for (const [method, path] of [
      ['GET', '/api/v1/nope'],
      ['DELETE', '/api/v1/auth/login'],
      ['PUT', '/api/v1/time'],
      ['TRACE', '/api/v1/time'],
      ['GET', '/'],
    ] as const) {
      const r = await anon.request({ method, path });
      expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.json, `${method} ${path}`).toMatchObject({
        error: { code: expect.any(String), message: expect.any(String) },
      });
    }
  });
});
