import { expect, test } from '@playwright/test';
import { createTeam, goOnShift, inject, poll, setClock, stubMail, uiLogin, uniq } from './support';

test('journey 2: two agents see each other in one ticket; the second reply needs confirmation', async ({
  browser,
}) => {
  const team = await createTeam(2);
  const [a1, a2] = team.agents.map((a) => a.email);
  await goOnShift(a1 ?? '');
  const customer = `${uniq('cust')}@customer.test`;
  await inject({
    from: customer,
    to: team.mailbox,
    subject: 'Two agents one ticket',
    text: 'Need an answer.',
  });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await uiLogin(pageA, a1 ?? '');
  await uiLogin(pageB, a2 ?? '');
  await pageA.goto('/');
  await pageA.getByTestId('ticket-row').filter({ hasText: 'Two agents one ticket' }).click();
  await pageA.waitForURL(/\/tickets\//);
  const ticketUrl = pageA.url();
  await pageB.goto(ticketUrl);
  await expect(pageB.getByTestId('ticket-subject')).toContainText('Two agents one ticket');

  // both see each other, and typing is shown
  await expect(pageA.getByTestId('presence-viewer')).toContainText('is viewing', {
    timeout: 20_000,
  });
  await expect(pageB.getByTestId('presence-viewer')).toContainText('is viewing', {
    timeout: 20_000,
  });
  await pageB.getByLabel('Reply to customer').last().fill('B is writing');
  await expect(pageA.getByTestId('presence-viewer')).toContainText('is typing', {
    timeout: 20_000,
  });

  // A answers first; B (who did not see that answer) must confirm
  await pageA.getByLabel('Reply to customer').last().fill('Answer from A');
  await pageA.getByTestId('send').click();
  await expect(pageA.getByTestId('undo-bar')).toBeVisible();
  await pageB.getByLabel('Reply to customer').last().fill('Answer from B');
  await pageB.getByTestId('send').click();
  await expect(pageB.getByTestId('conflict')).toBeVisible();
  await expect(pageB.getByTestId('conflict')).toContainText('Answer from A');
  await setClock({ advanceMs: 11_000 });
  await poll(
    async () => (await stubMail(customer)).some((m) => m.text.includes('Answer from A')),
    40_000,
    'A delivered',
  );
  expect((await stubMail(customer)).some((m) => m.text.includes('Answer from B'))).toBe(false); // nothing without confirmation
  await pageB.getByTestId('send-anyway').click();
  await expect(pageB.getByTestId('undo-bar')).toBeVisible();
  await setClock({ advanceMs: 11_000 });
  await poll(
    async () => (await stubMail(customer)).some((m) => m.text.includes('Answer from B')),
    40_000,
    'B delivered after confirmation',
  );
  await setClock({ offsetMs: 0 });
  await ctxA.close();
  await ctxB.close();
});
