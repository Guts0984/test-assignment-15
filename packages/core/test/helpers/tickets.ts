import { randomUUID } from 'node:crypto';
import { dbBusinessError, inTx, type Db, type Tx } from '../../src/index';
import {
  processInbound,
  type Ctx,
  type IngestOutcome,
  type TicketConfig,
  type TicketError,
} from '../../src/index';
import { uniq } from './db';

export const CFG: TicketConfig = {
  warningRatio: 0.8,
  undoSeconds: 10,
  linkTtlDays: 30,
  surveyTtlDays: 7,
  autoCloseHours: 72,
  mailDomain: 'helpdesk.test',
  publicBaseUrl: 'http://localhost:8080',
  maxAttachmentBytes: 10 * 1024 * 1024,
};

export const T0 = new Date('2026-03-04T09:00:00Z'); // Wednesday 11:00 Kyiv
export const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

export type Mail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
  attachment?: { name: string; content: Buffer };
};

export const rawMail = (m: Mail): Buffer => {
  const id = m.messageId ?? `${randomUUID()}@sender.test`;
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    `Message-ID: <${id}>`,
    ...(m.inReplyTo === undefined ? [] : [`In-Reply-To: <${m.inReplyTo}>`]),
    ...(m.references === undefined
      ? []
      : [
          `References: ${m.references
            .split(' ')
            .map((r) => `<${r}>`)
            .join(' ')}`,
        ]),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
  ];
  if (m.attachment === undefined) {
    return Buffer.from(
      [...headers, 'Content-Type: text/plain; charset=utf-8', '', m.text, ''].join('\r\n'),
    );
  }
  const b = `bnd-${randomUUID()}`;
  return Buffer.concat([
    Buffer.from(
      [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${b}"`,
        '',
        `--${b}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        m.text,
        `--${b}`,
        `Content-Type: application/octet-stream; name="${m.attachment.name}"`,
        `Content-Disposition: attachment; filename="${m.attachment.name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        m.attachment.content.toString('base64'),
        `--${b}--`,
        '',
      ].join('\r\n'),
    ),
  ]);
};

export const storeInbound = async (
  db: Db,
  mailbox: string,
  raw: Buffer,
  messageId: string,
): Promise<string | null> => {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO inbound_messages (mailbox_address, rfc_message_id, raw) VALUES (${mailbox}, ${messageId}, ${raw})
    ON CONFLICT (mailbox_address, rfc_message_id) DO NOTHING RETURNING id`;
  return rows[0]?.id ?? null;
};

/** Delivers a mail the way the api does (store, then process) and returns the outcome. */
export const deliver = async (
  db: Db,
  mailbox: string,
  m: Mail,
  now: Date = T0,
): Promise<{ id: string | null; outcome: IngestOutcome | null; messageId: string }> => {
  const messageId = m.messageId ?? `${randomUUID()}@sender.test`;
  const id = await storeInbound(db, mailbox, rawMail({ ...m, messageId }), messageId);
  if (id === null) return { id, outcome: null, messageId };
  return { id, outcome: await processInbound(db, id, now, CFG), messageId };
};

export type Business<T> = { ok: true; value: T } | { ok: false; error: TicketError };

/** Runs a use-case in its own transaction and turns trigger-raised business errors into values. */
export const run = async <T>(
  db: Db,
  now: Date,
  fn: (c: Ctx) => Promise<{ ok: true; value: T } | { ok: false; error: TicketError }>,
): Promise<Business<T>> => {
  try {
    return await inTx(db, (tx: Tx) => fn({ tx, now, cfg: CFG }));
  } catch (e) {
    const code = dbBusinessError(e);
    if (code === null) throw e;
    return {
      ok: false,
      error: { code: code === 'AGENT_AT_LIMIT' ? 'AGENT_AT_LIMIT' : code, message: code },
    };
  }
};

export const mailboxFor = async (
  db: Db,
  teamId: string,
  localPart = 'support',
): Promise<string> => {
  const address = `${localPart}-${uniq('m')}@helpdesk.test`.toLowerCase();
  await db.mailbox.create({ data: { address, defaultTeamId: teamId } });
  return address;
};

export const ticketOf = (db: Db, id: string): ReturnType<Db['ticket']['findUniqueOrThrow']> =>
  db.ticket.findUniqueOrThrow({ where: { id } });
export const eventsOf = (db: Db, ticketId: string): ReturnType<Db['ticketEvent']['findMany']> =>
  db.ticketEvent.findMany({ where: { ticketId }, orderBy: { id: 'asc' } });

import { createTicket } from '../../src/index';

/** A fresh ticket created through the real use-case (timers, history, ack included). */
export const newTicket = async (
  db: Db,
  teamId: string,
  o: {
    email?: string;
    priority?: 'urgent' | 'high' | 'normal' | 'low';
    now?: Date;
    language?: 'en' | 'uk' | 'pl' | 'de';
    ack?: boolean;
  } = {},
): Promise<{ ticketId: string; number: number; email: string }> => {
  const email = o.email ?? `${uniq('cust')}@customer.test`;
  const r = await run(db, o.now ?? T0, async (c) => ({
    ok: true as const,
    value: await createTicket(c, {
      customerEmail: email,
      customerName: 'Cust',
      subject: 'Subject',
      body: 'body',
      source: 'web',
      mailboxAddress: null,
      teamId,
      priority: o.priority ?? 'normal',
      language: o.language ?? 'en',
      rfcMessageId: `${uniq('mid')}@x.test`,
      inboundMessageId: null,
      followUpOfId: null,
      attachments: [],
      suppressAcknowledgement: o.ack !== true,
    }),
  }));
  if (!r.ok) throw new Error('ticket setup failed');
  return { ...r.value, email };
};
