import { randomUUID } from 'node:crypto';
import { processInbound, type TicketConfig } from '@helpdesk/core';
import { env } from '../../src/config/env';
import { signInbound } from '../../src/modules/inbound/domain/signature';
import { client } from '../attacker/client';
import type { Reply } from '../attacker/http';
import { testDb, uniq, type RunningApi } from './api';

export const cfg = (): TicketConfig => ({
  warningRatio: env.SLA_WARNING_RATIO,
  undoSeconds: env.UNDO_SEND_SECONDS,
  linkTtlDays: env.MAGIC_LINK_TTL_DAYS,
  surveyTtlDays: env.SURVEY_TTL_DAYS,
  autoCloseHours: env.AUTO_CLOSE_AFTER_HOURS,
  mailDomain: env.MAIL_DOMAIN,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  maxAttachmentBytes: env.MAX_ATTACHMENTS_BYTES,
});

export type Mail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  headers?: Record<string, string>;
};

export const rawMail = (m: Mail): Buffer =>
  Buffer.from(
    [
      `From: ${m.from}`,
      `To: ${m.to}`,
      `Subject: ${m.subject}`,
      `Message-ID: <${m.messageId ?? `${randomUUID()}@sender.test`}>`,
      ...(m.inReplyTo === undefined ? [] : [`In-Reply-To: <${m.inReplyTo}>`]),
      ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      m.text,
      '',
    ].join('\r\n'),
  );

/** Posts a mail to the inbound webhook exactly like the mail stub does (signed raw RFC 822). */
export const postMail = (
  api: RunningApi,
  mailbox: string,
  raw: Buffer,
  secret = env.INBOUND_WEBHOOK_SECRET,
  t = Math.floor(Date.now() / 1000),
): Promise<Reply> =>
  client({ baseUrl: api.url }).request({
    method: 'POST',
    path: '/api/v1/inbound/mail',
    body: raw,
    headers: {
      'content-type': 'message/rfc822',
      'x-envelope-to': mailbox,
      'x-inbound-signature': signInbound(secret, t, raw),
    },
  });

/** What a worker does: process every pending inbound mail of a mailbox. */
export const processPending = async (mailbox: string): Promise<void> => {
  const db = testDb();
  const rows = await db.inboundMessage.findMany({
    where: { mailboxAddress: mailbox, state: 'pending' },
    select: { id: true },
  });
  for (const r of rows) await processInbound(db, r.id, new Date(), cfg());
};

export const createMailbox = async (teamId: string): Promise<string> => {
  const address = `${uniq('box')}@${env.MAIL_DOMAIN}`;
  await testDb().mailbox.create({ data: { address, defaultTeamId: teamId } });
  return address;
};

/** A ticket arrives by email and is processed. */
export const receiveTicket = async (
  api: RunningApi,
  mailbox: string,
  over: Partial<Mail> = {},
): Promise<{ ticketId: string; number: number; from: string; messageId: string }> => {
  const from = over.from ?? `${uniq('cust')}@customer.test`;
  const messageId = `${randomUUID()}@sender.test`;
  const r = await postMail(
    api,
    mailbox,
    rawMail({
      from,
      to: mailbox,
      subject: 'Printer jammed',
      text: 'It is stuck',
      messageId,
      ...over,
    }),
  );
  if (r.status !== 202) throw new Error(`inbound failed ${r.status} ${r.text}`);
  await processPending(mailbox);
  const row = await testDb().inboundMessage.findFirstOrThrow({
    where: { mailboxAddress: mailbox, rfcMessageId: over.messageId ?? messageId },
  });
  const t = await testDb().ticket.findUniqueOrThrow({ where: { id: row.ticketId ?? '' } });
  return { ticketId: t.id, number: Number(t.number), from, messageId };
};

/** Fresh single-ticket customer link (what the email contains). */
export const linkFor = async (ticketId: string): Promise<string> => {
  const { createTicketLink } = await import('../../src/modules/auth/link-tokens');
  return createTicketLink(testDb(), { ticketId, now: new Date(), ttlDays: 30 });
};
