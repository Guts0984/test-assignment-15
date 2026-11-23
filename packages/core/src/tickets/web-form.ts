import { detectLanguage, routeTicket, type Language, type RoutingRule } from '@helpdesk/shared';
import { createTicket } from './create-ticket';
import type { AttachmentInput, Ctx } from './types';

export type WebFormInput = {
  readonly email: string;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly language?: Language | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly attachments: readonly AttachmentInput[];
};

export type WebFormResult = {
  readonly ticketId: string;
  readonly number: number;
  readonly duplicate: boolean;
};

/** Creates a ticket from the public form. A repeated idempotency key (double submit) returns the same ticket. */
export const createTicketFromForm = async (c: Ctx, i: WebFormInput): Promise<WebFormResult> => {
  const rfcMessageId =
    i.idempotencyKey === undefined ? null : `form-${i.idempotencyKey}@web.${c.cfg.mailDomain}`;
  if (rfcMessageId !== null) {
    const hit = await c.tx.$queryRaw<{ id: string; number: bigint }[]>`
      SELECT t.id, t.number FROM messages m JOIN tickets t ON t.id = m.ticket_id WHERE m.rfc_message_id = ${rfcMessageId}`;
    if (hit[0] !== undefined)
      return { ticketId: hit[0].id, number: Number(hit[0].number), duplicate: true };
  }
  const box = await c.tx.$queryRaw<{ address: string; default_team_id: string }[]>`
    SELECT address, default_team_id FROM mailboxes ORDER BY (address = ${`support@${c.cfg.mailDomain}`}) DESC, address LIMIT 1`;
  if (box[0] === undefined) throw new Error('No support mailbox is configured');
  const rules = await c.tx.$queryRaw<
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
  const language = i.language ?? detectLanguage(`${i.subject}\n${i.body}`);
  const decision = routeTicket(
    rules.map((r) => ({
      id: r.id,
      position: r.position,
      enabled: r.enabled,
      recipient: r.recipient,
      subjectKeywords: r.subject_keywords,
      language: r.language,
      teamId: r.team_id,
      priority: r.priority,
    })),
    { recipient: box[0].address, subject: i.subject, language },
    box[0].default_team_id,
  );
  const created = await createTicket(c, {
    customerEmail: i.email,
    customerName: i.name,
    subject: i.subject,
    body: i.body,
    source: 'web',
    mailboxAddress: box[0].address,
    teamId: decision.teamId,
    priority: decision.priority,
    language,
    rfcMessageId,
    inboundMessageId: null,
    followUpOfId: null,
    attachments: i.attachments,
    suppressAcknowledgement: false,
  });
  return { ticketId: created.ticketId, number: created.number, duplicate: false };
};
