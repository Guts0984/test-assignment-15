import type { Db } from '@helpdesk/core';
import { loadMessageViews, loadSummaries } from '@helpdesk/core';
import { canViewTicket, rooms, type Clock } from '@helpdesk/shared';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { createBudget } from './budget';
import { createPresence, type Presence } from './presence';
import { authenticateSocket, type SocketIdentity } from './socket-auth';

export type RealtimeDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly redis: Redis;
  readonly jwtSecret: string;
  readonly presenceTtlMs: number;
  readonly eventBudgetPerSecond: number;
};

type Ack = (r: unknown) => void;
const subscribeIn = z
  .object({
    ticketId: z.string().uuid(),
    lastSeq: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
const ticketIn = z.object({ ticketId: z.string().uuid() }).strict();
const presenceIn = z
  .object({ ticketId: z.string().uuid(), state: z.enum(['viewing', 'typing']) })
  .strict();

const identityOf = (s: Socket): SocketIdentity => s.data.identity as SocketIdentity;

/** Wires authentication, room authorization, presence, catch-up and the per-socket budget onto a Socket.IO server. */
export const setupRealtime = (
  io: Server,
  d: RealtimeDeps,
): { readonly presence: Presence; readonly stop: () => void } => {
  const sub = d.redis.duplicate();
  sub.on('error', () => undefined);
  io.adapter(createAdapter(d.redis, sub));
  const presence = createPresence(d.redis, d.presenceTtlMs);

  io.use((socket, next) => {
    void authenticateSocket(
      { db: d.db, clock: d.clock, jwtSecret: d.jwtSecret },
      socket.handshake.auth,
    )
      .then((r) => {
        if (!r.ok) return next(new Error(r.error));
        socket.data.identity = r.value;
        next();
      })
      .catch(() => next(new Error('UNAUTHORIZED')));
  });

  const broadcastPresence = async (ticketId: string): Promise<void> => {
    io.to(rooms.ticketStaff(ticketId)).emit('presence:changed', {
      ticketId,
      viewers: await presence.viewers(ticketId, d.clock.now().getTime()),
    });
  };

  io.on('connection', (socket) => {
    const who = identityOf(socket);
    const budget = createBudget(d.eventBudgetPerSecond);
    const watching = new Set<string>();
    if (who.kind === 'customer') {
      void socket.join(rooms.ticketCustomer(who.ticketId));
    } else {
      void socket.join(rooms.user(who.userId));
      if (who.principal.kind === 'admin') void socket.join(rooms.admin);
      else if (who.principal.kind === 'staff')
        for (const m of who.principal.memberships) void socket.join(rooms.team(m.teamId));
    }
    socket.emit('time:sync', { now: d.clock.now().toISOString() });

    /** Every client->server event passes the budget, schema validation and a catch-all, and always answers (or is dropped). */
    const handle = <S extends z.ZodTypeAny>(
      event: string,
      schema: S,
      fn: (input: z.output<S>, ack: Ack) => Promise<void>,
    ): void => {
      socket.on(event, (payload: unknown, ack?: Ack) => {
        const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
        if (!budget.take(Date.now()))
          return reply({ ok: false, error: { code: 'EVENT_BUDGET_EXCEEDED' } });
        const parsed = schema.safeParse(payload ?? {});
        if (!parsed.success) return reply({ ok: false, error: { code: 'VALIDATION_FAILED' } });
        fn(parsed.data as z.output<S>, reply).catch(() =>
          reply({ ok: false, error: { code: 'INTERNAL_ERROR' } }),
        );
      });
    };

    /** Staff only; permission is re-read from the database on every subscription. */
    const staffAccess = async (ticketId: string): Promise<boolean> => {
      if (who.kind !== 'staff') return false;
      const fresh = await authenticateSocket(
        { db: d.db, clock: d.clock, jwtSecret: d.jwtSecret },
        { token: socket.handshake.auth['token'] },
      );
      if (!fresh.ok || fresh.value.kind !== 'staff') return false;
      const rows = await d.db.$queryRaw<
        { team_id: string; customer_id: string }[]
      >`SELECT team_id, customer_id FROM tickets WHERE id = ${ticketId}::uuid`;
      const t = rows[0];
      return (
        t !== undefined &&
        canViewTicket(fresh.value.principal, {
          ticketId,
          teamId: t.team_id,
          customerId: t.customer_id,
        })
      );
    };

    handle('ticket:subscribe', subscribeIn, async (i, ack) => {
      if (who.kind !== 'staff' || !(await staffAccess(i.ticketId)))
        return ack({ ok: false, error: { code: 'NOT_FOUND' } });
      await socket.join(rooms.ticketStaff(i.ticketId));
      watching.add(i.ticketId);
      const nowMs = d.clock.now().getTime();
      await presence.heartbeat(
        i.ticketId,
        socket.id,
        { userId: who.userId, name: who.name },
        'viewing',
        nowMs,
      );
      const summary = (await loadSummaries(d.db, [i.ticketId])).get(i.ticketId) ?? null;
      const missedRows = await d.db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM messages WHERE ticket_id = ${i.ticketId}::uuid AND seq > ${i.lastSeq} AND cancelled_at IS NULL ORDER BY seq`;
      const missed = await loadMessageViews(
        d.db,
        missedRows.map((r) => r.id),
      );
      ack({
        ok: true,
        ticket: summary,
        missed: missed.sort((a, b) => a.seq - b.seq),
        viewers: await presence.viewers(i.ticketId, nowMs),
      });
      await broadcastPresence(i.ticketId);
    });

    handle('ticket:unsubscribe', ticketIn, async (i, ack) => {
      await socket.leave(rooms.ticketStaff(i.ticketId));
      watching.delete(i.ticketId);
      await presence.remove(i.ticketId, socket.id);
      ack({ ok: true });
      await broadcastPresence(i.ticketId);
    });

    handle('presence:update', presenceIn, async (i, ack) => {
      if (who.kind !== 'staff' || !socket.rooms.has(rooms.ticketStaff(i.ticketId)))
        return ack({ ok: false, error: { code: 'FORBIDDEN' } });
      await presence.heartbeat(
        i.ticketId,
        socket.id,
        { userId: who.userId, name: who.name },
        i.state,
        d.clock.now().getTime(),
      );
      ack({ ok: true });
      await broadcastPresence(i.ticketId);
    });

    handle('time:sync', z.object({}).strict(), async (_i, ack) =>
      ack({ ok: true, now: d.clock.now().toISOString() }),
    );

    socket.on('disconnect', () => {
      void (async () => {
        for (const ticketId of watching) {
          await presence.remove(ticketId, socket.id);
          await broadcastPresence(ticketId);
        }
      })().catch(() => undefined);
    });
  });

  // Crashed clients and dead api copies leave entries behind: expire them by time and tell the room.
  const reaper = setInterval(
    () => {
      void presence
        .reap(d.clock.now().getTime())
        .then((ids) => Promise.all(ids.map(broadcastPresence)))
        .catch(() => undefined);
    },
    Math.max(500, Math.floor(d.presenceTtlMs / 6)),
  );
  reaper.unref();
  const timeTicker = setInterval(
    () => io.emit('time:sync', { now: d.clock.now().toISOString() }),
    30_000,
  );
  timeTicker.unref();

  return {
    presence,
    stop: () => {
      clearInterval(reaper);
      clearInterval(timeTicker);
      void sub
        .ping()
        .catch(() => undefined)
        .then(() => sub.quit())
        .catch(() => undefined);
    },
  };
};
