import { expect, test } from '@playwright/test';
import { createTeam, goOnShift, inject, login, PASSWORD, uiLogin, uniq } from './support';

const base = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

const arrive = async (subject: string) => {
  const team = await createTeam(1);
  const agent = team.agents[0]?.email ?? '';
  await goOnShift(agent);
  const customer = `${uniq('cust')}@customer.test`;
  await inject({ from: customer, to: team.mailbox, subject, text: 'Body of the request' });
  return { team, agent, customer };
};

test('draft survives a reload, per ticket and per kind', async ({ page }) => {
  const { agent } = await arrive('Draft survives');
  await uiLogin(page, agent);
  await page.goto('/');
  await page.getByTestId('ticket-row').filter({ hasText: 'Draft survives' }).click();
  await page.getByLabel('Reply to customer').last().fill('Half written reply');
  await page.getByTestId('tab-note').click();
  await page.getByLabel('Internal note').last().fill('Half written note');
  await page.reload();
  await expect(page.getByTestId('ticket-subject')).toBeVisible();
  await expect(page.getByLabel('Reply to customer').last()).toHaveValue('Half written reply');
  await page.getByTestId('tab-note').click();
  await expect(page.getByLabel('Internal note').last()).toHaveValue('Half written note');
});

test('reply and note are visually distinct (label, border style, background)', async ({ page }) => {
  const { agent } = await arrive('Reply versus note');
  await uiLogin(page, agent);
  await page.goto('/');
  await page.getByTestId('ticket-row').filter({ hasText: 'Reply versus note' }).click();
  const panel = page.getByTestId('composer');
  const style = async () => panel.locator('div.rounded-md.border-2').evaluate((el) => { const s = getComputedStyle(el); return { border: s.borderTopStyle, bg: s.backgroundColor }; });
  await expect(panel).toHaveAttribute('data-kind', 'reply');
  const reply = await style();
  await expect(page.getByTestId('composer-hint')).toContainText('Public reply');
  await page.getByTestId('tab-note').click();
  await expect(panel).toHaveAttribute('data-kind', 'note');
  const note = await style();
  await expect(page.getByTestId('composer-hint')).toContainText('visible to staff only');
  expect(reply.border).toBe('solid');
  expect(note.border).toBe('dashed');
  expect(reply.bg).not.toBe(note.bg);
  await page.getByLabel('Internal note').last().fill('Only for colleagues');
  await page.getByTestId('send').click();
  const msg = page.getByTestId('message').filter({ hasText: 'Only for colleagues' });
  await expect(msg).toHaveAttribute('data-kind', 'note');
  await expect(msg).toContainText('Internal note');
  await expect(page.getByTestId('message').filter({ hasText: 'Body of the request' })).toHaveAttribute('data-kind', 'customer');
});

test('forms show errors next to the fields, including errors returned by the server', async ({ page }) => {
  await page.goto('/new-request');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByTestId('error-nr-email')).toBeVisible();
  await expect(page.getByTestId('error-nr-subject')).toBeVisible();
  await expect(page.getByTestId('error-nr-body')).toBeVisible();
  await expect(page.getByLabel('Your email')).toHaveAttribute('aria-invalid', 'true');
  // a value the browser-side schema accepts but the server rejects (control character) lands on the right field
  await page.getByLabel('Your email').fill('ann@customer.test');
  await page.getByLabel('Your name').fill('Ann');
  await page.getByLabel('Subject').fill('Line one\u0007bell');
  await page.getByLabel('How can we help?').fill('Text');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByTestId('error-nr-subject')).toBeVisible();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('error-email')).toBeVisible();
  await page.getByLabel('Email').fill('nobody@helpdesk.test');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid email or password')).toBeVisible();
});

test('the SLA countdown follows the server clock even when the browser clock is two hours off', async ({ page, context }) => {
  const { agent } = await arrive('Clock skew');
  await context.addInitScript(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 2 * 3_600_000; // the browser believes it is two hours later
  });
  await uiLogin(page, agent);
  await page.goto('/');
  const row = page.getByTestId('ticket-row').filter({ hasText: 'Clock skew' });
  await expect(row).toBeVisible();
  const remaining = Number(await row.getByTestId('sla-countdown').getAttribute('data-remaining-ms'));
  const token = await login(agent, PASSWORD);
  const r = await fetch(`${base}/api/v1/tickets/queue`, { headers: { authorization: `Bearer ${token}` } });
  const item = ((await r.json()) as { items: { subject: string; firstResponseDueAt: string }[]; serverTime: string }).items.find((i) => i.subject === 'Clock skew');
  const serverLeft = Date.parse(item?.firstResponseDueAt ?? '') - Date.now() - 0; // real Node clock = server clock here
  expect(Math.abs(remaining - serverLeft)).toBeLessThan(15_000); // equals the server's view, not the skewed browser's (which would be ~-2 h)
  expect(remaining).toBeGreaterThan(0);
});
