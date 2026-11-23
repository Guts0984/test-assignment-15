import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const base = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const stub = process.env.E2E_MAIL_STUB_URL ?? 'http://localhost:8025';
const controlToken = process.env.TEST_CONTROL_TOKEN ?? '';
const staffPassword = process.env.SEED_STAFF_PASSWORD ?? '';
const domain = process.env.MAIL_DOMAIN ?? 'helpdesk.test';
export const PASSWORD = 'E2e-Passw0rd!';

export const uniq = (p: string): string => `${p}-${randomUUID().slice(0, 8)}`;

const api = async (path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await r.text();
  return { status: r.status, json: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) };
};

export const login = async (email: string, password: string): Promise<string> => {
  const r = await api('/api/v1/auth/login', { method: 'POST', body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return String(r.json?.['accessToken']);
};

export const setClock = async (body: { advanceMs?: number; offsetMs?: number }): Promise<void> => {
  const r = await api('/api/v1/test/clock', { method: 'POST', body, headers: { 'x-test-control-token': controlToken } });
  if (r.status !== 200) throw new Error(`clock failed ${r.status}`);
};

export type E2eTeam = { teamId: string; mailbox: string; agents: { email: string; id: string }[]; lead: { email: string; id: string } };

export const createTeam = async (agents = 1): Promise<E2eTeam> => {
  const admin = await login('admin@helpdesk.test', staffPassword);
  const team = await api('/api/v1/admin/teams', { method: 'POST', token: admin, body: { name: uniq('E2E'), defaultLanguage: 'en', timeZone: 'Europe/Kyiv', workdays: [1, 2, 3, 4, 5, 6, 7], workStart: '00:00', workEnd: '24:00' } });
  const teamId = String(team.json?.['id']);
  const mailbox = `${uniq('e2e')}@${domain}`.toLowerCase();
  await api('/api/v1/admin/mailboxes', { method: 'POST', token: admin, body: { address: mailbox, defaultTeamId: teamId } });
  const make = async (role: 'agent' | 'lead') => {
    const email = `${uniq(role)}@${domain}`;
    const r = await api('/api/v1/admin/agents', { method: 'POST', token: admin, body: { email, name: `${role === 'lead' ? 'Lena Lead' : 'Alex Agent'} ${email.slice(-6)}`, password: PASSWORD, ticketLimit: role === 'lead' ? 0 : 20, languages: ['en'], memberships: [{ teamId, role }], active: true } });
    return { email, id: String(r.json?.['id']) };
  };
  const list = await Promise.all(Array.from({ length: agents }, () => make('agent')));
  return { teamId, mailbox, agents: list, lead: await make('lead') };
};

export const goOnShift = async (email: string): Promise<void> => {
  const t = await login(email, PASSWORD);
  await api('/api/v1/me/shift', { method: 'PUT', token: t, body: { onShift: true } });
};

export const inject = async (m: { from: string; to: string; subject: string; text: string; inReplyTo?: string }): Promise<void> => {
  const r = await fetch(`${stub}/api/inbound`, { method: 'POST', body: JSON.stringify(m) });
  if (!r.ok) throw new Error(`inject failed ${r.status}`);
};

export type StubMail = { subject: string; to: string[]; messageId: string | null; text: string };
export const stubMail = async (to: string): Promise<StubMail[]> => (await (await fetch(`${stub}/api/messages?to=${encodeURIComponent(to)}&limit=500`)).json()) as StubMail[];

export const uiLogin = async (page: Page, email: string): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('live-status')).toContainText('live');
};

export const poll = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 30_000, label = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== false && v !== null && v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${label} not met`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
