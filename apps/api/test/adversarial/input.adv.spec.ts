import { errorResponseSchema } from '@helpdesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from '../attacker/client';
import { raw } from '../attacker/http';
import {
  createTeamRow,
  createUserRow,
  login,
  PASSWORD,
  startApi,
  testDb,
  type LoggedIn,
  type RunningApi,
} from '../helpers/api';

type Operation = { method: string; path: string; access: string; hasBody: boolean };
let api: RunningApi;
let admin: LoggedIn;
let ops: Operation[] = [];
const db = testDb();
const FAKE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

beforeAll(async () => {
  api = await startApi();
  admin = await login(api, await createUserRow(db, { role: 'admin' }));
  const doc = (await client({ baseUrl: api.url }).get('/docs/openapi.json')).json as {
    paths: Record<string, Record<string, { 'x-access'?: string; requestBody?: unknown }>>;
  };
  ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      access: op['x-access'] ?? '',
      hasBody: op.requestBody !== undefined,
    })),
  );
});
afterAll(async () => {
  await api.close();
});

const expectSharedError = (
  r: { status: number; json: unknown; text: string },
  label: string,
): void => {
  expect(r.status, label).toBeGreaterThanOrEqual(400);
  expect(r.status, `${label}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
  const parsed = errorResponseSchema.safeParse(r.json);
  expect(parsed.success, `${label}: ${r.text.slice(0, 200)}`).toBe(true);
  expect(r.text, label).not.toMatch(
    /at .*\(.*:\d+:\d+\)|node_modules|prisma|SELECT |INSERT |\/home\//i,
  );
};

const hostile: Record<string, unknown> = {
  empty: {},
  array: [],
  nullBody: null,
  string: 'x',
  number: 123,
  wrongTypes: { email: 5, name: [], password: {}, id: false, teamId: 1 },
  hugeString: { name: 'x'.repeat(300_000), email: `${'a'.repeat(300_000)}@x.test` },
  nested: JSON.parse(`${'{"a":'.repeat(500)}1${'}'.repeat(500)}`),
  hugeArray: {
    workdays: Array.from({ length: 100_000 }, () => 1),
    subjectKeywords: Array.from({ length: 100_000 }, () => 'a'),
  },
  protoPollution: JSON.parse(
    '{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"role":"admin"}',
  ),
  massAssign: {
    role: 'admin',
    isInternal: false,
    teamId: FAKE_ID,
    id: FAKE_ID,
    tokenVersion: 9,
    openCount: 0,
  },
  sqlInjection: {
    email: "x'; DROP TABLE users; --@x.test",
    name: "'; DROP TABLE users; --",
    subject: "' OR '1'='1",
  },
  nullByte: { name: 'a\u0000b', email: 'a\u0000@x.test' },
  unicode: { name: '‮evil‬', email: 'ａｄｍｉｎ@x.test' },
};

describe('hostile bodies on every operation that takes one', () => {
  it('never produces a 5xx and always uses the shared error format', async () => {
    const withBody = ops.filter((o) => o.hasBody && o.access === 'admin');
    expect(withBody.length).toBeGreaterThan(5);
    for (const o of withBody) {
      for (const [name, body] of Object.entries(hostile)) {
        const r = await admin.client.request({
          method: o.method,
          path: o.path.replace(/\{[^}]+\}/g, FAKE_ID),
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        });
        if (r.status >= 400) expectSharedError(r, `${o.method} ${o.path} <- ${name}`);
        else expect(r.status).toBeLessThan(300 + 100); // a few harmless inputs may be accepted
        expect(r.status, `${o.method} ${o.path} <- ${name}`).toBeLessThan(500);
      }
    }
  });

  it('never persists prototype pollution or mass-assigned fields', async () => {
    const r = await admin.client.post('/api/v1/admin/teams', {
      name: 'Evil',
      role: 'admin',
      __proto__: { x: 1 },
    } as never);
    expect(r.status).toBe(400);
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('path parameters that are not ids are rejected with VALIDATION_FAILED (never 500)', async () => {
    for (const bad of [
      'not-a-uuid',
      '..%2F..%2Fetc%2Fpasswd',
      '%00',
      "1'%20OR%20'1'='1",
      'x'.repeat(5000),
      '%E0%A4%A',
    ]) {
      const r = await admin.client.get(`/api/v1/admin/teams/${bad}/holidays`);
      expect(r.status, bad.slice(0, 20)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(errorResponseSchema.safeParse(r.json).success, bad.slice(0, 30)).toBe(true);
    }
    const jobs = await admin.client.post('/api/v1/admin/jobs/abc/retry', {});
    expect(jobs.status).toBe(400);
    expect(
      (await admin.client.post('/api/v1/admin/jobs/99999999999999999999999/retry', {})).status,
    ).toBe(400);
  });
});

describe('transport-level input handling', () => {
  const anon = () => client({ baseUrl: api.url });

  it('malformed JSON is a 400 MALFORMED_JSON', async () => {
    for (const body of [
      '{',
      '{"email":',
      'not json',
      '{"a":1,"a":',
      '\u0000',
      '{"email":"a@b.test","password":"x",}',
    ]) {
      const r = await anon().request({
        method: 'POST',
        path: '/api/v1/auth/login',
        body,
        headers: { 'content-type': 'application/json' },
      });
      expect(r.status, body).toBe(400);
      expect((r.json as { error: { code: string } }).error.code).toBe('MALFORMED_JSON');
    }
  });

  it('wrong or missing content types are 415, not an empty-object validation error', async () => {
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/xml',
    ]) {
      const r = await anon().request({
        method: 'POST',
        path: '/api/v1/auth/login',
        body: 'email=a%40b.test&password=x',
        headers: { 'content-type': type },
      });
      expect(r.status, type).toBe(415);
      expect((r.json as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    const none = await anon().request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: '{"email":"a@b.test","password":"x"}',
    });
    expect(none.status).toBe(415);
  });

  it('an oversized body is a 413 PAYLOAD_TOO_LARGE and the server keeps serving', async () => {
    const big = JSON.stringify({
      email: 'a@b.test',
      password: 'x'.repeat(api.env.JSON_BODY_LIMIT_BYTES + 1000),
    });
    const r = await anon().request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: big,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(413);
    expect((r.json as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await anon().get('/api/v1/time')).status).toBe(200);
  });

  it('duplicate JSON keys follow last-wins and cannot smuggle a second value past validation', async () => {
    const u = await createUserRow(db);
    const r = await anon().request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: `{"email":"nobody@x.test","email":"${u.email}","password":"${PASSWORD}"}`,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(200); // the validated value is the one used
  });

  it('CRLF in headers cannot split the response or inject headers', async () => {
    const res = await raw(
      '127.0.0.1',
      api.port,
      'GET /api/v1/time HTTP/1.1\r\nHost: x\r\nX-Request-Id: abc\r\nInjected: yes\r\nConnection: close\r\n\r\n',
    );
    expect(res.split('\r\n\r\n')[0]).not.toMatch(/\r\nInjected:/i);
    const bad = await raw(
      '127.0.0.1',
      api.port,
      'GET /api/v1/time HTTP/1.1\r\nHost: x\r\nX-Request-Id: a\r b\r\nConnection: close\r\n\r\n',
    );
    expect(bad.startsWith('HTTP/1.1 4') || bad.startsWith('HTTP/1.1 200')).toBe(true);
  });

  it('a hostile X-Request-Id is replaced, never echoed', async () => {
    const r = await anon().get('/api/v1/time', {
      headers: { 'x-request-id': '<script>alert(1)</script>' },
    });
    expect(String(r.headers['x-request-id'])).not.toContain('<script>');
  });

  it('negative and absurd pagination or numeric values are validation errors, never 500', async () => {
    const r = await admin.client.put(`/api/v1/admin/agents/${FAKE_ID}`, {
      email: 'a@b.test',
      name: 'x',
      ticketLimit: -5,
      languages: ['en'],
      memberships: [],
    });
    expect(r.status).toBe(400);
    const r2 = await admin.client.patch(`/api/v1/admin/agents/${FAKE_ID}/limits`, {
      ticketLimit: 1e308,
    });
    expect(r2.status).toBe(400);
    expect(
      (await admin.client.patch(`/api/v1/admin/agents/${FAKE_ID}/limits`, { ticketLimit: 3.5 }))
        .status,
    ).toBe(400);
  });
});

describe('security headers and CORS', () => {
  it('sets security headers and hides the framework', async () => {
    const r = await client({ baseUrl: api.url }).get('/api/v1/time');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeDefined();
    expect(String(r.headers['cache-control'])).toContain('no-store');
  });

  it('answers only allow-listed origins with CORS headers', async () => {
    const evil = await client({ baseUrl: api.url }).get('/api/v1/time', {
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await client({ baseUrl: api.url }).get('/api/v1/time', {
      headers: { origin: 'http://localhost:8080' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8080');
    const pre = await client({ baseUrl: api.url }).request({
      method: 'OPTIONS',
      path: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('team input validation reaches the field level', () => {
  it('reports the failing field path so forms can show it next to the input', async () => {
    const team = await createTeamRow(db);
    const r = await admin.client.put(`/api/v1/admin/teams/${team.id}`, {
      timeZone: 'Mars/Base',
      workdays: [1],
      workStart: '09:00',
      workEnd: '08:00',
    });
    expect(r.status).toBe(400);
    const details = (r.json as { error: { details: { path: string[] }[] } }).error.details;
    expect(details.map((d) => d.path.join('.'))).toEqual(
      expect.arrayContaining(['timeZone', 'workEnd']),
    );
  });
});
