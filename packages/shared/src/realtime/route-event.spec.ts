import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  rooms,
  routeRealtimeEvent,
  type DomainEvent,
  type MessageView,
  type TicketSummary,
} from './route-event';

const ticket: TicketSummary = {
  id: 't1',
  number: 100001,
  subject: 'Printer',
  status: 'open',
  priority: 'high',
  teamId: 'A',
  assigneeId: 'u1',
  customerId: 'c1',
  version: 3,
  nextDueAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const msg = (over: Partial<MessageView>): MessageView => ({
  id: 'm1',
  ticketId: 't1',
  seq: 1,
  kind: 'public',
  direction: 'outbound',
  authorKind: 'agent',
  authorName: 'Agent Smith',
  body: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
  releasedAt: '2026-01-01T00:00:10.000Z',
  ...over,
});

const customerRoom = rooms.ticketCustomer('t1');

describe('routeRealtimeEvent', () => {
  it('sends ticket.created to the team, admins and the assignee only', () => {
    const rs = routeRealtimeEvent({ type: 'ticket.created', ticket })
      .map((r) => r.room)
      .sort();
    expect(rs).toEqual(['admin', 'team:A', 'user:u1']);
  });

  it('ticket.updated reaches the previous assignee too and gives the customer a reduced view', () => {
    const routed = routeRealtimeEvent({ type: 'ticket.updated', ticket, previousAssigneeId: 'u9' });
    expect(routed.map((r) => r.room)).toContain('user:u9');
    const toCustomer = routed.find((r) => r.room === customerRoom);
    expect(toCustomer?.payload).toEqual({
      ticket: {
        id: 't1',
        number: 100001,
        subject: 'Printer',
        status: 'open',
        version: 3,
        updatedAt: ticket.updatedAt,
      },
    });
  });

  it('never sends an internal note to the customer room', () => {
    const routed = routeRealtimeEvent({
      type: 'message.created',
      ticket,
      message: msg({ kind: 'note', body: 'SECRET NOTE' }),
    });
    expect(routed.some((r) => r.room === customerRoom)).toBe(false);
    expect(routed.some((r) => r.room === rooms.ticketStaff('t1'))).toBe(true);
  });

  it('never sends an unreleased (still undoable) reply to the customer room', () => {
    const routed = routeRealtimeEvent({
      type: 'message.created',
      ticket,
      message: msg({ releasedAt: null }),
    });
    expect(routed.some((r) => r.room === customerRoom)).toBe(false);
  });

  it('sends a released public reply to the customer without internal fields', () => {
    const routed = routeRealtimeEvent({ type: 'message.created', ticket, message: msg({}) });
    const payload = JSON.stringify(routed.find((r) => r.room === customerRoom)?.payload);
    expect(payload).toContain('hello');
    expect(payload).not.toContain('assigneeId');
    expect(payload).not.toContain('teamId');
    expect(payload).not.toContain('nextDueAt');
    expect(payload).not.toContain('priority');
  });

  it('cancelled replies are staff-only', () => {
    const routed = routeRealtimeEvent({ type: 'message.cancelled', ticket, messageId: 'm1' });
    expect(routed.every((r) => r.room !== customerRoom)).toBe(true);
  });

  it('property: no customer-room payload ever contains note text or staff-only fields', () => {
    const eventArb: fc.Arbitrary<DomainEvent> = fc.oneof(
      fc.constant<DomainEvent>({ type: 'ticket.created', ticket }),
      fc
        .record({ previousAssigneeId: fc.option(fc.string(), { nil: undefined }) })
        .map((o): DomainEvent => ({ type: 'ticket.updated', ticket, ...o })),
      fc
        .record({
          kind: fc.constantFrom('public' as const, 'note' as const),
          released: fc.boolean(),
          authorKind: fc.constantFrom('customer' as const, 'agent' as const, 'system' as const),
        })
        .map((o): DomainEvent => ({
          type: 'message.created',
          ticket,
          message: msg({
            kind: o.kind,
            authorKind: o.authorKind,
            body: o.kind === 'note' ? 'NOTE-TEXT' : 'public-text',
            releasedAt: o.released ? '2026-01-01T00:00:10.000Z' : null,
          }),
        })),
      fc.constant<DomainEvent>({ type: 'message.cancelled', ticket, messageId: 'm1' }),
    );
    fc.assert(
      fc.property(eventArb, (e) => {
        for (const r of routeRealtimeEvent(e)) {
          if (r.room !== customerRoom) continue;
          const json = JSON.stringify(r.payload);
          expect(json).not.toContain('NOTE-TEXT');
          for (const f of ['assigneeId', 'teamId', 'customerId', 'nextDueAt', '"priority"'])
            expect(json).not.toContain(f);
        }
      }),
    );
  });
});
