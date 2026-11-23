import { expect, test } from '@playwright/test';
import { createTeam, goOnShift, inject, setClock, stubMail, uiLogin, uniq, poll } from './support';

test('the queue and the reply editor work with the keyboard only', async ({ page }) => {
  const team = await createTeam(1);
  const agent = team.agents[0]?.email ?? '';
  await goOnShift(agent);
  const customer = `${uniq('cust')}@customer.test`;
  for (const n of ['Keyboard one', 'Keyboard two']) await inject({ from: customer, to: team.mailbox, subject: n, text: 'hello' });
  await uiLogin(page, agent);
  await page.goto('/');
  await expect(page.getByTestId('ticket-row')).toHaveCount(2, { timeout: 30_000 });
  await page.getByTestId('ticket-list').focus();
  await page.keyboard.press('j');
  await expect(page.getByTestId('ticket-row').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('k');
  await expect(page.getByTestId('ticket-row').nth(0)).toHaveAttribute('aria-selected', 'true');
  const subject = (await page.getByTestId('ticket-row').nth(0).locator('span.truncate').first().innerText()).trim();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ticket-subject')).toContainText(subject);
  // focus the editor with Tab only, type, send with Ctrl+Enter, then undo with the focused Undo button (Enter)
  const editor = page.getByLabel('Reply to customer').last();
  for (let i = 0; i < 60 && !(await editor.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Typed without a mouse');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('undo-bar')).toBeVisible();
  await expect(page.getByTestId('undo-send')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('undo-bar')).toBeHidden();
  await expect(editor).toHaveValue('Typed without a mouse');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('undo-bar')).toBeVisible();
  await setClock({ advanceMs: 11_000 });
  await poll(async () => (await stubMail(customer)).find((m) => m.text.includes('Typed without a mouse')), 40_000, 'mail sent');
  await setClock({ offsetMs: 0 });
});

test('search text and report filters live in the URL: reload and Back restore them', async ({ page }) => {
  const team = await createTeam(1);
  const agent = team.agents[0]?.email ?? '';
  await goOnShift(agent);
  const word = `zebra${uniq('w').replace('-', '')}`;
  await inject({ from: `${uniq('c')}@customer.test`, to: team.mailbox, subject: `Find ${word}`, text: `contains ${word} here` });
  await uiLogin(page, agent);
  await page.goto('/search');
  await page.getByTestId('search-input').fill(word);
  await expect(page).toHaveURL(new RegExp(`q=${word}`));
  await expect(page.getByTestId('ticket-row')).toHaveCount(1, { timeout: 20_000 });
  await page.reload();
  await expect(page.getByTestId('search-input')).toHaveValue(word);
  await expect(page.getByTestId('ticket-row')).toHaveCount(1);
  await page.goto('/search');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`q=${word}`));

  const lead = await page.context().browser()?.newContext();
  const lp = await lead?.newPage();
  if (lp === undefined) throw new Error('no page');
  await uiLogin(lp, team.lead.email);
  await lp.goto('/reports?from=2026-01-01&to=2026-12-31');
  await lp.getByLabel('Priority').selectOption('high');
  await expect(lp).toHaveURL(/priority=high/);
  await lp.getByLabel('From').fill('2026-02-01');
  await expect(lp).toHaveURL(/from=2026-02-01/);
  await lp.reload();
  await expect(lp.getByLabel('Priority')).toHaveValue('high');
  await expect(lp.getByLabel('From')).toHaveValue('2026-02-01');
  await lp.goBack();
  await expect(lp.getByLabel('From')).toHaveValue('2026-01-01');
  await lead?.close();
});

test('the lead dashboard updates live when a ticket arrives', async ({ page }) => {
  const team = await createTeam(1); // nobody on shift: new tickets wait in the team queue
  await uiLogin(page, team.lead.email);
  await page.goto('/dashboard');
  await page.getByTestId('dashboard-team').selectOption(team.teamId);
  await expect(page.getByTestId('unassigned-count')).toHaveText('0');
  await inject({ from: `${uniq('c')}@customer.test`, to: team.mailbox, subject: 'Dashboard live', text: 'x' });
  await expect(page.getByTestId('unassigned-count')).toHaveText('1', { timeout: 20_000 });
});
