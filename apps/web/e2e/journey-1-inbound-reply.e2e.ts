import { expect, test } from '@playwright/test';
import { createTeam, goOnShift, inject, poll, setClock, stubMail, uiLogin, uniq } from './support';

test('journey 1: inbound email -> assigned ticket appears live -> reply -> customer gets the email -> customer replies by email -> same ticket', async ({ page }) => {
  const team = await createTeam(1);
  const agent = team.agents[0]?.email ?? '';
  await goOnShift(agent);
  await uiLogin(page, agent);
  await page.goto('/');
  await expect(page.getByText('No tickets are assigned to you')).toBeVisible();

  const customer = `${uniq('cust')}@customer.test`;
  await inject({ from: customer, to: team.mailbox, subject: 'My printer will not print', text: 'Please help me with the printer.' });
  // the new ticket shows up in my queue without reloading the page
  const row = page.getByTestId('ticket-row').filter({ hasText: 'My printer will not print' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId('sla-countdown')).toBeVisible();
  await row.click();
  await expect(page.getByTestId('ticket-subject')).toContainText('My printer will not print');
  await expect(page.getByTestId('thread')).toContainText('Please help me with the printer.');

  // reply (public), then let the 10-second undo window pass through the shared test clock
  await page.getByTestId('tab-reply').click();
  await page.getByLabel('Reply to customer').last().fill('Hello! Please restart the printer.');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('undo-bar')).toBeVisible();
  await setClock({ advanceMs: 11_000 });
  const reply = await poll(async () => (await stubMail(customer)).find((m) => m.text.includes('restart the printer')), 40_000, 'customer received the reply');
  expect(reply.subject).toMatch(/^\[#\d+\] My printer will not print/);
  expect((await stubMail(customer)).filter((m) => m.text.includes('restart the printer'))).toHaveLength(1);
  await setClock({ offsetMs: 0 });

  // the customer answers the reply by email: the message lands in the same ticket, live
  await inject({ from: customer, to: team.mailbox, subject: `Re: ${reply.subject}`, text: 'Thanks, it works now!', inReplyTo: reply.messageId ?? '' });
  await expect(page.getByTestId('thread')).toContainText('Thanks, it works now!', { timeout: 30_000 });
  await expect(page.getByTestId('message')).toHaveCount(3);
});
