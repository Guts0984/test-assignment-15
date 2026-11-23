import { randomUUID } from 'node:crypto';
import { appendTicketEvent } from '../events/ticket-events';
import { collectorOf } from '../realtime/collector';
import type { Tx } from '../db/client';
import type { ActorRef, AttachmentInput, TicketRow } from './types';

type RawTicket = {
  id: string;
  number: bigint;
  subject: string;
  status: string;
  priority: string;
  language: string;
  team_id: string;
  customer_id: string;
  assignee_id: string | null;
  merged_into_id: string | null;
  follow_up_of_id: string | null;
  version: number;
  message_seq: number;
  created_at: Date;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  mailbox_address: string | null;
};

const toRow = (r: RawTicket): TicketRow => ({
  id: r.id,
  number: Number(r.number),
  subject: r.subject,
  status: r.status,
  priority: r.priority,
  language: r.language,
  teamId: r.team_id,
  customerId: r.customer_id,
  assigneeId: r.assignee_id,
  mergedIntoId: r.merged_into_id,
  followUpOfId: r.follow_up_of_id,
  version: r.version,
  messageSeq: r.message_seq,
  createdAt: r.created_at,
  firstRespondedAt: r.first_responded_at,
  resolvedAt: r.resolved_at,
  mailboxAddress: r.mailbox_address,
});

/** Loads a ticket, optionally taking its row lock; every state change starts here. */
export const getTicket = async (tx: Tx, id: string, lock: boolean): Promise<TicketRow | null> => {
  const rows = lock
    ? await tx.$queryRaw<
        RawTicket[]
      >`SELECT id, number, subject, status, priority, language, team_id, customer_id, assignee_id, merged_into_id, follow_up_of_id, version, message_seq, created_at, first_responded_at, resolved_at, mailbox_address FROM tickets WHERE id = ${id}::uuid FOR UPDATE`
    : await tx.$queryRaw<
        RawTicket[]
      >`SELECT id, number, subject, status, priority, language, team_id, customer_id, assignee_id, merged_into_id, follow_up_of_id, version, message_seq, created_at, first_responded_at, resolved_at, mailbox_address FROM tickets WHERE id = ${id}::uuid`;
  const r = rows[0];
  return r === undefined ? null : toRow(r);
};

/** Locks several tickets in id order, so concurrent multi-ticket operations cannot deadlock. */
export const lockTickets = async (tx: Tx, ids: readonly string[]): Promise<TicketRow[]> => {
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<
    RawTicket[]
  >`SELECT id, number, subject, status, priority, language, team_id, customer_id, assignee_id, merged_into_id, follow_up_of_id, version, message_seq, created_at, first_responded_at, resolved_at, mailbox_address FROM tickets WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
  return rows.map(toRow);
};

/** Follows `merged_into_id` to the main ticket (merges can chain: A into B, then B into C). */
export const rootTicketId = async (tx: Tx, id: string): Promise<string> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT id, merged_into_id, 0 AS depth FROM tickets WHERE id = ${id}::uuid
      UNION ALL
      SELECT t.id, t.merged_into_id, c.depth + 1 FROM tickets t JOIN chain c ON t.id = c.merged_into_id WHERE c.depth < 50
    )
    SELECT id FROM chain WHERE merged_into_id IS NULL ORDER BY depth DESC LIMIT 1`;
  return rows[0]?.id ?? id;
};

/** Reserves the next per-ticket message sequence number; the caller holds the ticket lock. */
export const nextSeq = async (tx: Tx, ticketId: string): Promise<number> => {
  const rows = await tx.$queryRaw<{ message_seq: number }[]>`
    UPDATE tickets SET message_seq = message_seq + 1 WHERE id = ${ticketId}::uuid RETURNING message_seq`;
  return rows[0]?.message_seq ?? 0;
};

export type NewMessage = {
  readonly ticketId: string;
  readonly kind: 'public' | 'note';
  readonly direction: 'inbound' | 'outbound' | 'internal';
  readonly authorKind: 'customer' | 'agent' | 'system';
  readonly authorUserId?: string | null;
  readonly authorName?: string | null;
  readonly body: string;
  readonly rfcMessageId?: string | null;
  readonly inboundMessageId?: string | null;
  readonly autoKind?: 'autoreply' | 'bounce' | null;
  readonly createdAt: Date;
  readonly releasedAt?: Date | null;
  readonly originTicketId?: string | null;
};

export const insertMessage = async (
  tx: Tx,
  m: NewMessage,
): Promise<{ id: string; seq: number }> => {
  const seq = await nextSeq(tx, m.ticketId);
  const id = randomUUID();
  collectorOf(tx).messages.add(id);
  await tx.$executeRaw`
    INSERT INTO messages (id, ticket_id, seq, kind, direction, author_kind, author_user_id, author_name, body,
                          rfc_message_id, inbound_message_id, auto_kind, created_at, released_at, origin_ticket_id)
    VALUES (${id}::uuid, ${m.ticketId}::uuid, ${seq}, ${m.kind}, ${m.direction}, ${m.authorKind},
            ${m.authorUserId ?? null}::uuid, ${m.authorName ?? null}, ${m.body}, ${m.rfcMessageId ?? null},
            ${m.inboundMessageId ?? null}::uuid, ${m.autoKind ?? null}, ${m.createdAt}, ${m.releasedAt ?? null},
            ${m.originTicketId ?? null}::uuid)`;
  return { id, seq };
};

const SAFE_NAME = /[\\/\x00-\x1f\x7f"<>|:*?]/g;

/** Basename only, no control or path characters, bounded length, never empty. */
export const sanitizeFilename = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(SAFE_NAME, '_').replace(/^\.+/, '').trim().slice(0, 255);
  return clean === '' ? 'attachment' : clean;
};

export const insertAttachments = async (
  tx: Tx,
  messageId: string,
  files: readonly AttachmentInput[],
  now: Date,
): Promise<void> => {
  for (const f of files) {
    await tx.$executeRaw`
      INSERT INTO attachments (message_id, filename, content_type, size, data, created_at)
      VALUES (${messageId}::uuid, ${sanitizeFilename(f.filename)}, ${f.contentType.slice(0, 200)}, ${f.data.length}, ${f.data}, ${now})`;
  }
};

/** Adds a history row and bumps the ticket version (clients ignore events older than the version they hold). */
export const touch = async (
  tx: Tx,
  ticketId: string,
  now: Date,
  queued?: 'queue' | 'unqueue',
): Promise<void> => {
  collectorOf(tx).updated.add(ticketId);
  await tx.$executeRaw`
    UPDATE tickets SET version = version + 1, updated_at = ${now},
           queued_at = CASE ${queued ?? 'keep'} WHEN 'queue' THEN ${now} WHEN 'unqueue' THEN NULL ELSE queued_at END
     WHERE id = ${ticketId}::uuid`;
};

export const history = async (
  tx: Tx,
  ticketId: string,
  type: string,
  actor: ActorRef,
  now: Date,
  data: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await appendTicketEvent(tx, {
    ticketId,
    type,
    actorKind: actor.kind,
    actorUserId: actor.userId,
    data,
    at: now,
  });
};
