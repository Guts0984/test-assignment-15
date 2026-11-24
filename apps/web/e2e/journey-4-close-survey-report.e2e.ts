import { expect, test } from '@playwright/test';
import { createTeam, goOnShift, inject, poll, setClock, stubMail, uiLogin, uniq } from './support';

test('journey 4: resolved -> three days pass -> closed -> survey -> the rating shows in the report', async ({
  page,
  browser,
}) => {
  const team = await createTeam(1);
  const agent = team.agents[0]?.email ?? '';
  await goOnShift(agent);
  const customer = `${uniq('cust')}@customer.test`;
  await inject({ from: customer, to: team.mailbox, subject: 'Finish me', text: 'question' });
  await uiLogin(page, agent);
  await page.goto('/');
  await page.getByTestId('ticket-row').filter({ hasText: 'Finish me' }).click();
  await page.getByTestId('status-select').selectOption('resolved');
  // The badge shows the status the server saved ('Resolved' is also an option of the dropdown, so text alone proves nothing).
  await expect(page.getByTestId('ticket-status')).toHaveAttribute('data-status', 'resolved');

  await setClock({ advanceMs: 3 * 86_400_000 + 60_000 }); // three days pass
  const survey = await poll(
    async () => (await stubMail(customer)).find((m) => /survey#token=/.test(m.text)),
    60_000,
    'survey email after auto-close',
  );
  const token = /survey#token=([A-Za-z0-9_-]{43})/.exec(survey.text)?.[1] ?? '';
  const customerCtx = await browser.newContext();
  const survey1 = await customerCtx.newPage();
  await survey1.goto(`/survey#token=${token}`);
  await expect(survey1.getByTestId('survey')).toContainText('Finish me');
  await survey1.getByText('5 ★').click();
  await survey1.getByLabel('Comment (optional)').fill('Quick and friendly');
  await survey1.getByTestId('save-rating').click();
  await expect(survey1.getByTestId('rating-saved')).toBeVisible();
  await customerCtx.close();

  // the team lead sees the rating in the report (period and filters in the URL)
  const leadCtx = await browser.newContext();
  const lead = await leadCtx.newPage();
  await uiLogin(lead, team.lead.email);
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await lead.goto(`/reports?from=${from}&to=${day}&team=${team.teamId}`);
  await expect(lead.getByTestId('report-total')).toContainText('5 (1)');
  await expect(lead.getByTestId('report-ratings')).toContainText('5★ 1');
  await expect(lead).toHaveURL(new RegExp(`team=${team.teamId}`));
  await leadCtx.close();
  await setClock({ offsetMs: 0 });
});
