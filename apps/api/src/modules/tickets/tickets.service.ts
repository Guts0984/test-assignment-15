import {
  dbBusinessError,
  inTx,
  type Ctx,
  type Db,
  type TicketConfig,
  type TicketError,
} from '@helpdesk/core';
import {
  canViewTicket,
  canWorkOnTicket,
  isLeadOf,
  type Clock,
  type Principal,
  type Result,
  type TicketScope,
} from '@helpdesk/shared';
import type { ActorRef } from '@helpdesk/core';
import { appError } from '../../common/errors/app-error';
import type { RequestAuth } from '../../common/auth/request-auth';

export type TicketServiceDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly cfg: TicketConfig;
};

export type TicketBrief = TicketScope & {
  readonly status: string;
  readonly assigneeId: string | null;
  readonly number: number;
};

const DB_CODES = {
  AGENT_AT_LIMIT: 'Agent is at their ticket limit',
  TICKETS_NOT_MERGEABLE: 'These tickets cannot be merged',
  TICKET_ALREADY_MERGED: 'A merged ticket cannot be merged again',
} as const;

/** Thin plumbing around the core use-cases: transactions, permission loading, error mapping. */
export const createTicketService = (d: TicketServiceDeps) => {
  const brief = async (ticketId: string): Promise<TicketBrief | null> => {
    const rows = await d.db.$queryRaw<
      {
        id: string;
        team_id: string;
        customer_id: string;
        status: string;
        assignee_id: string | null;
        number: bigint;
      }[]
    >`
      SELECT id, team_id, customer_id, status, assignee_id, number FROM tickets WHERE id = ${ticketId}::uuid`;
    const r = rows[0];
    return r === undefined
      ? null
      : {
          ticketId: r.id,
          teamId: r.team_id,
          customerId: r.customer_id,
          status: r.status,
          assigneeId: r.assignee_id,
          number: Number(r.number),
        };
  };

  return {
    cfg: d.cfg,
    now: (): Date => d.clock.now(),
    brief,

    /** Loads a ticket for a staff caller; unknown tickets and tickets outside their teams are both "not found". */
    requireTicket: async (
      auth: RequestAuth,
      ticketId: string,
      need: 'view' | 'work' = 'work',
    ): Promise<TicketBrief> => {
      const b = await brief(ticketId);
      const allowed =
        b !== null &&
        auth.kind === 'staff' &&
        (need === 'view' ? canViewTicket(auth.principal, b) : canWorkOnTicket(auth.principal, b));
      if (b === null || !allowed) throw appError('NOT_FOUND', 'Ticket not found');
      return b;
    },

    actorFor: (auth: RequestAuth, teamId: string): ActorRef => {
      if (auth.kind !== 'staff') return { kind: 'customer', userId: null };
      const p: Principal = auth.principal;
      return {
        kind: p.kind === 'admin' ? 'admin' : isLeadOf(p, teamId) ? 'lead' : 'agent',
        userId: auth.user.id,
      };
    },

    /** Runs a use-case in one transaction and turns expected failures (including trigger-raised ones) into HTTP errors. */
    command: async <T>(fn: (c: Ctx) => Promise<Result<T, TicketError>>): Promise<T> => {
      const now = d.clock.now();
      let result: Result<T, TicketError>;
      try {
        result = await inTx(d.db, (tx) => fn({ tx, now, cfg: d.cfg }));
      } catch (e) {
        const code = dbBusinessError(e);
        if (code === null) throw e;
        throw appError(code, DB_CODES[code]);
      }
      if (result.ok) return result.value;
      const data = result.error.data;
      throw appError(
        result.error.code,
        result.error.message,
        undefined,
        data === undefined ? undefined : (data as Record<string, unknown>),
      );
    },

    db: d.db,
  };
};

export type TicketService = ReturnType<typeof createTicketService>;
