import {
  detectAutomated,
  detectLanguage,
  routeTicket,
  ticketNumberFromSubject,
  type Language,
  type RoutingRule,
} from '@helpdesk/shared';
import type { Db } from '../db/client';
import { inTx, type Tx } from '../db/client';
import { collectorOf, flushCollector, type RealtimePublisher } from '../realtime/collector';
import { appendCustomerMessage } from './customer-message';
import { createTicket } from './create-ticket';
import { parseRawMail, type ParsedMail } from './mail-parse';
import { history, insertMessage, rootTicketId } from './store';
import type { Ctx, TicketConfig } from './types';

export type IngestOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'duplicate'; readonly ticketId: string | null }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'ignored_automated' }
  | { readonly kind: 'automated_attached'; readonly ticketId: string }
  | { readonly kind: 'created'; readonly ticketId: string; readonly number: number }
  | { readonly kind: 'appended'; readonly ticketId: string; readonly reopened: boolean }
  | { readonly kind: 'follow_up'; readonly ticketId: string; readonly number: number };

type InboundRow = { id: string; mailbox_address: string; raw: Buffer };

/** Finds the ticket a mail belongs to: Message-ID headers first, then the [#number] tag. Sender must match the customer. */
const findThread = async (
  c: Ctx,
  mail: ParsedMail,
  requireCustomerSender = true,
): Promise<{ ticketId: string; viaOutboundId: string | null } | null> => {
  const candidates = [...mail.inReplyTo, ...[...mail.references].reverse()];
  const unique = [...new Set(candidates)];
  const matches =
    unique.length === 0
      ? []
      : await c.tx.$queryRaw<{ rfc: string; ticket_id: string; outbound: boolean }[]>`
    SELECT rfc_message_id AS rfc, ticket_id, false AS outbound FROM messages WHERE rfc_message_id = ANY(${unique})
    UNION ALL
    SELECT rfc_message_id AS rfc, ticket_id, true AS outbound FROM outbound_emails WHERE rfc_message_id = ANY(${unique})`;
  let found: { ticketId: string; viaOutboundId: string | null } | null = null;
  for (const id of unique) {
    const hit = matches.find((m) => m.rfc === id);
    if (hit !== undefined) {
      // A reply's Message-ID exists both as a thread message and as an outbound email; the outbound row is what a
      // bounce must mark, so it counts even when the message row is found first.
      const outbound = matches.some((m) => m.rfc === id && m.outbound);
      found = { ticketId: hit.ticket_id, viaOutboundId: outbound ? hit.rfc : null };
      break;
    }
  }
  if (found === null) {
    const n = ticketNumberFromSubject(mail.subject);
    if (n !== null) {
      const rows = await c.tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM tickets WHERE number = ${n}`;
      if (rows[0] !== undefined) found = { ticketId: rows[0].id, viaOutboundId: null };
    }
  }
  if (found === null) return null;
  const rootId = await rootTicketId(c.tx, found.ticketId);
  const owner = await c.tx.$queryRaw<{ email: string }[]>`
    SELECT c.email FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.id = ${rootId}::uuid`;
  // Anti-forgery: a spoofed header or subject number only counts when it comes from the ticket's own customer.
  if (requireCustomerSender && owner[0]?.email !== mail.fromEmail) return null;
  return { ticketId: found.ticketId, viaOutboundId: found.viaOutboundId };
};

const loadRules = async (c: Ctx): Promise<RoutingRule[]> => {
  const rows = await c.tx.$queryRaw<
    {
      id: string;
      position: number;
      enabled: boolean;
      recipient: string | null;
      subject_keywords: string[];
      language: Language | null;
      team_id: string;
      priority: RoutingRule['priority'];
    }[]
  >`SELECT id, position, enabled, recipient, subject_keywords, language, team_id, priority FROM routing_rules`;
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    enabled: r.enabled,
    recipient: r.recipient,
    subjectKeywords: r.subject_keywords,
    language: r.language,
    teamId: r.team_id,
    priority: r.priority,
  }));
};

const setInbound = async (
  c: Ctx,
  id: string,
  state: 'processed' | 'rejected',
  ticketId: string | null,
  error: string | null,
): Promise<void> => {
  await c.tx
    .$executeRaw`UPDATE inbound_messages SET state = ${state}, ticket_id = ${ticketId}::uuid, error = ${error} WHERE id = ${id}::uuid`;
};

/** Applies one parsed inbound mail inside the caller's transaction. */
export const applyInbound = async (
  c: Ctx,
  inboundId: string,
  mailbox: string,
  mail: ParsedMail,
): Promise<IngestOutcome> => {
  const existing = await c.tx.$queryRaw<
    { ticket_id: string }[]
  >`SELECT ticket_id FROM messages WHERE rfc_message_id = ${mail.messageId}`;
  if (existing[0] !== undefined) {
    await setInbound(c, inboundId, 'processed', existing[0].ticket_id, null);
    return { kind: 'duplicate', ticketId: existing[0].ticket_id };
  }
  const box = await c.tx.$queryRaw<
    { default_team_id: string }[]
  >`SELECT default_team_id FROM mailboxes WHERE address = ${mailbox}`;
  if (box[0] === undefined) {
    await setInbound(c, inboundId, 'rejected', null, `unknown mailbox ${mailbox}`);
    return { kind: 'rejected', reason: 'unknown mailbox' };
  }
  const verdict = detectAutomated(mail.headers, {
    returnPath: mail.returnPath,
    from: mail.fromEmail,
  });
  // A bounce comes from a mail server, not from the customer, so it is matched by the Message-ID it refers to alone.
  const thread = await findThread(c, mail, verdict?.kind !== 'bounce');

  if (verdict !== null) {
    if (thread === null) {
      await setInbound(
        c,
        inboundId,
        'processed',
        null,
        `dropped ${verdict.kind}: ${verdict.reason}`,
      );
      return { kind: 'ignored_automated' };
    }
    const rootId = await rootTicketId(c.tx, thread.ticketId);
    await insertMessage(c.tx, {
      ticketId: rootId,
      kind: 'note',
      direction: 'internal',
      authorKind: 'system',
      body: `[${verdict.kind}] ${mail.text.slice(0, 2000)}`,
      rfcMessageId: mail.messageId,
      inboundMessageId: inboundId,
      autoKind: verdict.kind,
      createdAt: c.now,
    });
    if (verdict.kind === 'bounce' && thread.viaOutboundId !== null) {
      await c.tx
        .$executeRaw`UPDATE outbound_emails SET state = 'bounced' WHERE rfc_message_id = ${thread.viaOutboundId} AND state = 'sent'`;
    }
    await history(c.tx, rootId, 'auto_reply_ignored', { kind: 'system', userId: null }, c.now, {
      kind: verdict.kind,
      reason: verdict.reason,
    });
    await setInbound(c, inboundId, 'processed', rootId, null);
    return { kind: 'automated_attached', ticketId: rootId };
  }

  const body = mail.text === '' ? '(empty message)' : mail.text;
  const subject = mail.subject === '' ? '(no subject)' : mail.subject;
  const language = detectLanguage(`${subject}\n${body}`);
  const message = {
    body,
    attachments: mail.attachments,
    rfcMessageId: mail.messageId,
    inboundMessageId: inboundId,
    customerEmail: mail.fromEmail,
    customerName: mail.fromName,
    subject,
    suppressAcknowledgement: false,
  };

  if (thread !== null) {
    const r = await appendCustomerMessage(c, thread.ticketId, message, {
      priority: 'normal',
      language,
    });
    if (!r.ok) {
      await setInbound(c, inboundId, 'rejected', null, r.error.message);
      return { kind: 'rejected', reason: r.error.message };
    }
    if (r.value.kind === 'follow_up') {
      await setInbound(c, inboundId, 'processed', r.value.created.ticketId, null);
      return {
        kind: 'follow_up',
        ticketId: r.value.created.ticketId,
        number: r.value.created.number,
      };
    }
    await setInbound(c, inboundId, 'processed', r.value.ticketId, null);
    return { kind: 'appended', ticketId: r.value.ticketId, reopened: r.value.reopened };
  }

  const decision = routeTicket(
    await loadRules(c),
    { recipient: mailbox, subject, language },
    box[0].default_team_id,
  );
  const created = await createTicket(c, {
    customerEmail: mail.fromEmail,
    customerName: mail.fromName,
    subject,
    body,
    source: 'email',
    mailboxAddress: mailbox,
    teamId: decision.teamId,
    priority: decision.priority,
    language,
    rfcMessageId: mail.messageId,
    inboundMessageId: inboundId,
    followUpOfId: null,
    attachments: mail.attachments,
    suppressAcknowledgement: false,
  });
  await setInbound(c, inboundId, 'processed', created.ticketId, null);
  return { kind: 'created', ticketId: created.ticketId, number: created.number };
};

/**
 * Processes one stored inbound mail exactly once: it claims the row (`FOR UPDATE SKIP LOCKED`, still pending),
 * does all domain writes and marks it processed in the caller's transaction. A crash anywhere rolls everything back.
 */
export const processInboundTx = async (c: Ctx, inboundId: string): Promise<IngestOutcome> => {
  const rows = await c.tx.$queryRaw<InboundRow[]>`
    SELECT id, mailbox_address, raw FROM inbound_messages WHERE id = ${inboundId}::uuid AND state = 'pending' FOR UPDATE SKIP LOCKED`;
  const row = rows[0];
  if (row === undefined) return { kind: 'skipped' } as const;
  const parsed = await parseRawMail(Buffer.from(row.raw), c.cfg.maxAttachmentBytes);
  if (!parsed.ok) {
    await setInbound(c, row.id, 'rejected', null, parsed.error);
    return { kind: 'rejected', reason: parsed.error } as const;
  }
  return applyInbound(c, row.id, row.mailbox_address, parsed.value);
};

export const processInbound = async (
  db: Db,
  inboundId: string,
  now: Date,
  cfg: TicketConfig,
  publisher: RealtimePublisher | null = null,
): Promise<IngestOutcome> => {
  const ref: { tx: Tx | null } = { tx: null };
  const outcome = await inTx(db, (tx) => {
    ref.tx = tx;
    return processInboundTx({ tx, now, cfg }, inboundId);
  });
  if (publisher !== null && ref.tx !== null)
    await flushCollector(db, collectorOf(ref.tx), publisher).catch(() => undefined);
  return outcome;
};
