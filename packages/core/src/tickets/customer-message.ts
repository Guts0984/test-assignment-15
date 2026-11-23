import { ok, type Result } from '@helpdesk/shared';
import { cancelJob, requestTeamAssignment } from '../jobs/jobs';
import { createTicket, type CreatedTicket } from './create-ticket';
import { history, insertAttachments, insertMessage, rootTicketId, getTicket, touch } from './store';
import { syncSla } from './sla-sync';
import { fail, type AttachmentInput, type Ctx, type TicketError } from './types';
import type { Priority, Language } from '@helpdesk/shared';

export type CustomerMessage = {
  readonly body: string;
  readonly attachments: readonly AttachmentInput[];
  readonly rfcMessageId: string | null;
  readonly inboundMessageId: string | null;
  readonly customerEmail: string;
  readonly customerName: string;
  readonly subject: string;
  readonly suppressAcknowledgement: boolean;
};

export type AppendOutcome =
  | {
      readonly kind: 'appended';
      readonly ticketId: string;
      readonly messageId: string;
      readonly reopened: boolean;
    }
  | { readonly kind: 'follow_up'; readonly created: CreatedTicket };

/**
 * A customer message arrives for an existing conversation (email thread or portal).
 * Active ticket: append (and end a customer-waiting pause). Resolved: reopen. Closed: new ticket linked to the old one.
 * Merged tickets are resolved to their main ticket first.
 */
export const appendCustomerMessage = async (
  c: Ctx,
  ticketId: string,
  m: CustomerMessage,
  followUp: { readonly priority: Priority; readonly language: Language },
): Promise<Result<AppendOutcome, TicketError>> => {
  const rootId = await rootTicketId(c.tx, ticketId);
  const t = await getTicket(c.tx, rootId, true);
  if (t === null) return fail('NOT_FOUND', 'Ticket not found');
  const customer = { kind: 'customer' as const, userId: null };

  if (t.status === 'closed') {
    const created = await createTicket(c, {
      customerEmail: m.customerEmail,
      customerName: m.customerName,
      subject: t.subject,
      body: m.body,
      source: 'email',
      mailboxAddress: t.mailboxAddress,
      teamId: t.teamId,
      priority: followUp.priority,
      language: followUp.language,
      rfcMessageId: m.rfcMessageId,
      inboundMessageId: m.inboundMessageId,
      followUpOfId: t.id,
      attachments: m.attachments,
      suppressAcknowledgement: m.suppressAcknowledgement,
    });
    return ok({ kind: 'follow_up', created });
  }

  const msg = await insertMessage(c.tx, {
    ticketId: t.id,
    kind: 'public',
    direction: 'inbound',
    authorKind: 'customer',
    body: m.body,
    rfcMessageId: m.rfcMessageId,
    inboundMessageId: m.inboundMessageId,
    createdAt: c.now,
  });
  await insertAttachments(c.tx, msg.id, m.attachments, c.now);
  await c.tx
    .$executeRaw`UPDATE tickets SET last_customer_msg_at = ${c.now} WHERE id = ${t.id}::uuid`;
  await history(c.tx, t.id, 'customer_reply', customer, c.now, { messageId: msg.id });

  let reopened = false;
  if (t.status === 'waiting_customer') {
    await c.tx
      .$executeRaw`UPDATE sla_pauses SET ended_at = ${c.now} WHERE ticket_id = ${t.id}::uuid AND ended_at IS NULL`;
    await c.tx.$executeRaw`UPDATE tickets SET status = 'open' WHERE id = ${t.id}::uuid`;
    await history(c.tx, t.id, 'status_changed', customer, c.now, {
      from: 'waiting_customer',
      to: 'open',
    });
    await syncSla(c.tx, t.id, c.now, c.cfg.warningRatio);
  } else if (t.status === 'resolved') {
    await c.tx
      .$executeRaw`UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = ${t.id}::uuid`;
    await cancelJob(c.tx, `auto_close:${t.id}`, c.now);
    await history(c.tx, t.id, 'reopened', customer, c.now, { from: 'resolved', to: 'open' });
    await syncSla(c.tx, t.id, c.now, c.cfg.warningRatio);
    reopened = true;
  }
  await touch(c.tx, t.id, c.now);
  if (t.assigneeId === null) await requestTeamAssignment(c.tx, t.teamId, c.now);
  return ok({ kind: 'appended', ticketId: t.id, messageId: msg.id, reopened });
};
