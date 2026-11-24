import { expect, test } from '@playwright/test';
import { createTeam, goOnShift, inject, setClock, stubMail, uiLogin, uniq } from './support';

test('journey 3: undo within 10 seconds - the email is never sent and the draft comes back', async ({
  page,
}) => {
  const team = await createTeam(1);
  const agent = team.agents[0]?.email ?? '';
  await goOnShift(agent);
  const customer = `${uniq('cust')}@customer.test`;
  await inject({ from: customer, to: team.mailbox, subject: 'Undo me', text: 'question' });
  await uiLogin(page, agent);
  await page.goto('/');
  await page.getByTestId('ticket-row').filter({ hasText: 'Undo me' }).click();
  await page.getByLabel('Reply to customer').last().fill('This must not be sent');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('undo-bar')).toBeVisible();
  const seconds = Number(await page.getByTestId('undo-seconds').innerText());
  expect(seconds).toBeGreaterThan(5);
  await page.getByTestId('undo-send').click();
  await expect(page.getByTestId('undo-bar')).toBeHidden();
  await expect(page.getByLabel('Reply to customer').last()).toHaveValue('This must not be sent'); // restored for editing
  await expect(
    page.getByTestId('message').filter({ hasText: 'This must not be sent' }),
  ).toHaveAttribute('data-undone', 'true');
  await setClock({ advanceMs: 5 * 60_000 }); // long past the window
  await page.waitForTimeout(4000);
  expect(
    (await stubMail(customer)).filter((m) => m.text.includes('This must not be sent')),
  ).toHaveLength(0);
  await setClock({ offsetMs: 0 });
});
