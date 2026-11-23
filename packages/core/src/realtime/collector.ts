import type { DomainEvent, MessageView, TicketSummary } from '@helpdesk/shared';
import type { Queryable, Tx } from '../db/client';

/** Everything a transaction changed that clients should hear about, recorded per transaction client object. */
export type Collector = {
  readonly created: Set<string>;
  readonly updated: Set<string>;
  readonly messages: Set<string>;
  /** Extra users who must learn about a ticket although they no longer own it (previous assignee). */
  readonly alsoNotify: Map<string, Set<string>>;
  /** Tickets whose staff / customer room members must be re-authorized (team change, merge). */
  readonly revokeStaff: Set<string>;
  readonly revokeCustomer: Set<string>;
};

const store = new WeakMap<object, Collector>();

export const collectorOf = (tx: Tx | Queryable): Collector => {
  let c = store.get(tx);
  if (c === undefined) {
    c = {
      created: new Set(),
      updated: new Set(),
      messages: new Set(),
      alsoNotify: new Map(),
      revokeStaff: new Set(),
      revokeCustomer: new Set(),
    };
    store.set(tx, c);
  }
  return c;
};

export const newCollector = (): Collector => ({
  created: new Set(),
  updated: new Set(),
  messages: new Set(),
  alsoNotify: new Map(),
  revokeStaff: new Set(),
  revokeCustomer: new Set(),
});

export const notifyPreviousOwner = (tx: Tx, ticketId: string, userId: string | null): void => {
  if (userId === null) return;
  const m = collectorOf(tx).alsoNotify;
  m.set(ticketId, (m.get(ticketId) ?? new Set()).add(userId));
};

export const hasChanges = (c: Collector): boolean =>
  c.created.size + c.updated.size + c.messages.size + c.revokeStaff.size + c.revokeCustomer.size >
  0;

/** Where events go after commit (Socket.IO through the Redis emitter, or a test double). */
export type RealtimePublisher = {
  readonly publish: (events: readonly DomainEvent[]) => Promise<void>;
  readonly revokeStaffAccess: (ticketId: string) => Promise<void>;
  readonly revokeCustomerAccess: (ticketId: string) => Promise<void>;
};

type SummaryRow = {
  id: string;
  number: bigint;
  subject: string;
  status: string;
  priority: string;
  team_id: string;
  assignee_id: string | null;
  customer_id: string;
  version: number;
  next_due_at: Date | null;
  updated_at: Date;
};

export const loadSummaries = async (
  db: Queryable,
  ids: readonly string[],
): Promise<Map<string, TicketSummary>> => {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<SummaryRow[]>`
    SELECT id, number, subject, status, priority, team_id, assignee_id, customer_id, version, next_due_at, updated_at
      FROM tickets WHERE id = ANY(${[...ids]}::uuid[])`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        number: Number(r.number),
        subject: r.subject,
        status: r.status as TicketSummary['status'],
        priority: r.priority as TicketSummary['priority'],
        teamId: r.team_id,
        assigneeId: r.assignee_id,
        customerId: r.customer_id,
        version: r.version,
        nextDueAt: r.next_due_at?.toISOString() ?? null,
        updatedAt: r.updated_at.toISOString(),
      },
    ]),
  );
};

type MessageRow = {
  id: string;
  ticket_id: string;
  seq: number;
  kind: string;
  direction: string;
  author_kind: string;
  author_name: string | null;
  body: string;
  created_at: Date;
  released_at: Date | null;
  cancelled_at: Date | null;
};

export const loadMessageViews = async (
  db: Queryable,
  ids: readonly string[],
): Promise<MessageView[]> => {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<MessageRow[]>`
    SELECT m.id, m.ticket_id, m.seq, m.kind, m.direction, m.author_kind, COALESCE(m.author_name, u.name) AS author_name, m.body,
           m.created_at, m.released_at, m.cancelled_at
      FROM messages m LEFT JOIN users u ON u.id = m.author_user_id WHERE m.id = ANY(${[...ids]}::uuid[]) AND m.cancelled_at IS NULL`;
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    seq: r.seq,
    kind: r.kind as 'public' | 'note',
    direction: r.direction as MessageView['direction'],
    authorKind: r.author_kind as MessageView['authorKind'],
    authorName: r.author_name,
    body: r.body,
    createdAt: r.created_at.toISOString(),
    releasedAt: r.released_at?.toISOString() ?? null,
  }));
};

/** Turns a collector into domain events by reading the committed state, then hands them to the publisher. */
export const flushCollector = async (
  db: Queryable,
  c: Collector,
  publisher: RealtimePublisher,
): Promise<void> => {
  if (!hasChanges(c)) return;
  const messageViews = await loadMessageViews(db, [...c.messages]);
  const ticketIds = new Set([...c.created, ...c.updated, ...messageViews.map((m) => m.ticketId)]);
  const summaries = await loadSummaries(db, [...ticketIds]);
  const events: DomainEvent[] = [];
  for (const id of c.created) {
    const t = summaries.get(id);
    if (t !== undefined) events.push({ type: 'ticket.created', ticket: t });
  }
  for (const id of c.updated) {
    const t = summaries.get(id);
    if (t === undefined || c.created.has(id)) continue;
    const prev = [...(c.alsoNotify.get(id) ?? [])][0];
    events.push({
      type: 'ticket.updated',
      ticket: t,
      ...(prev === undefined ? {} : { previousAssigneeId: prev }),
    });
  }
  for (const m of messageViews) {
    const t = summaries.get(m.ticketId);
    if (t !== undefined) events.push({ type: 'message.created', ticket: t, message: m });
  }
  for (const id of c.revokeStaff) await publisher.revokeStaffAccess(id);
  for (const id of c.revokeCustomer) await publisher.revokeCustomerAccess(id);
  await publisher.publish(events);
};

/** Runs `fn` in a transaction and, after it commits, publishes what it changed. Publisher failures never undo the work. */
export const publishAfter = async <T>(
  db: Queryable,
  tx: Tx,
  publisher: RealtimePublisher | null,
  value: T,
): Promise<T> => {
  if (publisher !== null)
    await flushCollector(db, collectorOf(tx), publisher).catch(() => undefined);
  return value;
};
