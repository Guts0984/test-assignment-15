import type { Tx } from '../db/client';

export type ActorKind = 'system' | 'customer' | 'agent' | 'lead' | 'admin';

export type EventInput = {
  readonly ticketId: string;
  readonly type: string;
  readonly actorKind: ActorKind;
  readonly actorUserId?: string | null;
  readonly actorLabel?: string | null;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly at: Date;
};

/** Appends one history row. Always called in the same transaction as the change it records. */
export const appendTicketEvent = async (tx: Tx, e: EventInput): Promise<void> => {
  await tx.$executeRaw`
    INSERT INTO ticket_events (ticket_id, type, actor_kind, actor_user_id, actor_label, data, created_at)
    VALUES (${e.ticketId}::uuid, ${e.type}, ${e.actorKind}, ${e.actorUserId ?? null}::uuid, ${e.actorLabel ?? null},
            ${JSON.stringify(e.data ?? {})}::jsonb, ${e.at})`;
};
