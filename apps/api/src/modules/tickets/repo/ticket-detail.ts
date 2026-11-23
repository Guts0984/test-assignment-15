import type { Queryable } from '@helpdesk/core';
import { getListItem } from './ticket-queries';

type MsgRow = {
  id: string;
  seq: number;
  kind: string;
  direction: string;
  author_kind: string;
  author_name: string | null;
  body: string;
  created_at: Date;
  released_at: Date | null;
  cancelled_at: Date | null;
  auto_kind: string | null;
  origin_ticket_id: string | null;
  send_after: Date | null;
  send_state: string | null;
};

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Everything the ticket view shows: header, whole correspondence (notes included), history. */
export const loadTicketDetail = async (db: Queryable, id: string) => {
  const item = await getListItem(db, id);
  if (item === null) return null;
  const extra = await db.$queryRawUnsafe<
    {
      customer_id: string;
      merged_into_id: string | null;
      merged_number: bigint | null;
      follow_up_of_id: string | null;
      follow_number: bigint | null;
      resolved_at: Date | null;
      closed_at: Date | null;
      message_seq: number;
    }[]
  >(
    `SELECT t.customer_id, t.merged_into_id, mt.number AS merged_number, t.follow_up_of_id, ft.number AS follow_number, t.resolved_at, t.closed_at, t.message_seq
       FROM tickets t LEFT JOIN tickets mt ON mt.id = t.merged_into_id LEFT JOIN tickets ft ON ft.id = t.follow_up_of_id WHERE t.id = $1::uuid`,
    id,
  );
  const messages = await db.$queryRawUnsafe<MsgRow[]>(
    `SELECT m.id, m.seq, m.kind, m.direction, m.author_kind, COALESCE(m.author_name, u.name) AS author_name, m.body, m.created_at, m.released_at,
            m.cancelled_at, m.auto_kind, m.origin_ticket_id, o.send_after, o.state AS send_state
       FROM messages m LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN outbound_emails o ON o.message_id = m.id
      WHERE m.ticket_id = $1::uuid ORDER BY m.seq`,
    id,
  );
  const attachments = await db.$queryRawUnsafe<
    { id: string; message_id: string; filename: string; content_type: string; size: number }[]
  >(
    `SELECT a.id, a.message_id, a.filename, a.content_type, a.size FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.ticket_id = $1::uuid ORDER BY a.created_at`,
    id,
  );
  const events = await db.$queryRawUnsafe<
    {
      id: bigint;
      type: string;
      actor_kind: string;
      actor_name: string | null;
      data: Record<string, unknown>;
      created_at: Date;
    }[]
  >(
    `SELECT e.id, e.type, e.actor_kind, u.name AS actor_name, e.data, e.created_at FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.ticket_id = $1::uuid ORDER BY e.id`,
    id,
  );
  const x = extra[0];
  if (x === undefined) return null;
  return {
    ticket: {
      ...item,
      customerId: x.customer_id,
      mergedIntoId: x.merged_into_id,
      mergedIntoNumber: x.merged_number === null ? null : Number(x.merged_number),
      followUpOfId: x.follow_up_of_id,
      followUpOfNumber: x.follow_number === null ? null : Number(x.follow_number),
      resolvedAt: iso(x.resolved_at),
      closedAt: iso(x.closed_at),
      messageSeq: x.message_seq,
    },
    messages: messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      kind: m.kind as 'public' | 'note',
      direction: m.direction as 'inbound' | 'outbound' | 'internal',
      authorKind: m.author_kind as 'customer' | 'agent' | 'system',
      authorName: m.author_name,
      body: m.body,
      createdAt: m.created_at.toISOString(),
      releasedAt: iso(m.released_at),
      cancelledAt: iso(m.cancelled_at),
      sendAfter: iso(m.send_after),
      sendState: m.send_state,
      autoKind: m.auto_kind as 'autoreply' | 'bounce' | null,
      originTicketId: m.origin_ticket_id,
      attachments: attachments
        .filter((a) => a.message_id === m.id)
        .map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
        })),
    })),
    events: events.map((e) => ({
      id: String(e.id),
      type: e.type,
      actorKind: e.actor_kind,
      actorName: e.actor_name,
      data: e.data,
      createdAt: e.created_at.toISOString(),
    })),
  };
};
