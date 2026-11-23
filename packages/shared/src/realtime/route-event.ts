import type { MessageKind, Priority, TicketStatus } from '../domain/constants';

export type TicketSummary = {
  readonly id: string;
  readonly number: number;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: Priority;
  readonly teamId: string;
  readonly assigneeId: string | null;
  readonly customerId: string;
  /** Increases on every change; clients ignore events with a version they already have. */
  readonly version: number;
  readonly nextDueAt: string | null;
  readonly updatedAt: string;
};

export type MessageView = {
  readonly id: string;
  readonly ticketId: string;
  readonly seq: number;
  readonly kind: MessageKind;
  readonly direction: 'inbound' | 'outbound';
  readonly authorKind: 'customer' | 'agent' | 'system';
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
  /** Set when an agent reply has been handed to the mail system; customers only ever see released replies. */
  readonly releasedAt: string | null;
};

export type DomainEvent =
  | { readonly type: 'ticket.created'; readonly ticket: TicketSummary }
  | {
      readonly type: 'ticket.updated';
      readonly ticket: TicketSummary;
      readonly previousAssigneeId?: string | null;
    }
  | {
      readonly type: 'message.created';
      readonly ticket: TicketSummary;
      readonly message: MessageView;
    }
  | {
      readonly type: 'message.cancelled';
      readonly ticket: TicketSummary;
      readonly messageId: string;
    };

export const rooms = {
  user: (id: string): string => `user:${id}`,
  team: (id: string): string => `team:${id}`,
  ticketStaff: (id: string): string => `ticket:${id}:staff`,
  ticketCustomer: (id: string): string => `ticket:${id}:customer`,
  admin: 'admin',
} as const;

export type RoutedEvent = {
  readonly room: string;
  readonly event: string;
  readonly payload: unknown;
};

/** The only fields a customer may ever receive about a ticket. */
export const toCustomerTicketView = (
  t: TicketSummary,
): Pick<TicketSummary, 'id' | 'number' | 'subject' | 'status' | 'version' | 'updatedAt'> => ({
  id: t.id,
  number: t.number,
  subject: t.subject,
  status: t.status,
  version: t.version,
  updatedAt: t.updatedAt,
});

export const toCustomerMessageView = (
  m: MessageView,
): Omit<MessageView, 'kind'> & { readonly kind: 'public' } => ({
  id: m.id,
  ticketId: m.ticketId,
  seq: m.seq,
  kind: 'public',
  direction: m.direction,
  authorKind: m.authorKind,
  authorName: m.authorKind === 'agent' ? m.authorName : null,
  body: m.body,
  createdAt: m.createdAt,
  releasedAt: m.releasedAt,
});

/**
 * Maps a domain event to (room, payload) pairs. Staff rooms get full data. The customer room gets
 * only the customer view and only released public messages, so notes and unsent replies never reach it.
 */
export const routeRealtimeEvent = (e: DomainEvent): readonly RoutedEvent[] => {
  const out: RoutedEvent[] = [];
  const t = e.ticket;
  const staffRooms = [rooms.team(t.teamId), rooms.ticketStaff(t.id), rooms.admin];
  switch (e.type) {
    case 'ticket.created':
      for (const room of [rooms.team(t.teamId), rooms.admin])
        out.push({ room, event: e.type, payload: { ticket: t } });
      if (t.assigneeId !== null)
        out.push({ room: rooms.user(t.assigneeId), event: e.type, payload: { ticket: t } });
      break;
    case 'ticket.updated': {
      for (const room of staffRooms) out.push({ room, event: e.type, payload: { ticket: t } });
      const users = new Set([t.assigneeId, e.previousAssigneeId ?? null]);
      for (const u of users)
        if (u !== null) out.push({ room: rooms.user(u), event: e.type, payload: { ticket: t } });
      out.push({
        room: rooms.ticketCustomer(t.id),
        event: e.type,
        payload: { ticket: toCustomerTicketView(t) },
      });
      break;
    }
    case 'message.created':
      for (const room of [rooms.ticketStaff(t.id)])
        out.push({ room, event: e.type, payload: { ticket: t, message: e.message } });
      if (t.assigneeId !== null)
        out.push({
          room: rooms.user(t.assigneeId),
          event: e.type,
          payload: { ticket: t, message: e.message },
        });
      if (e.message.kind === 'public' && e.message.releasedAt !== null) {
        out.push({
          room: rooms.ticketCustomer(t.id),
          event: e.type,
          payload: { ticket: toCustomerTicketView(t), message: toCustomerMessageView(e.message) },
        });
      }
      break;
    case 'message.cancelled':
      out.push({
        room: rooms.ticketStaff(t.id),
        event: e.type,
        payload: { ticket: t, messageId: e.messageId },
      });
      break;
  }
  return out;
};
