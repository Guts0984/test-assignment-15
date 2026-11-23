import { rooms } from '@helpdesk/shared';
import type { Redis } from 'ioredis';

export type PresenceEntry = {
  readonly userId: string;
  readonly name: string;
  readonly state: 'viewing' | 'typing';
  /** Last heartbeat (ms, from the injected clock). An entry older than the TTL no longer counts. */
  readonly seenAt: number;
  readonly typingAt: number;
};

export type Viewer = {
  readonly userId: string;
  readonly name: string;
  readonly state: 'viewing' | 'typing';
};

const KEY = (ticketId: string): string => `hd:presence:${ticketId}`;
const ACTIVE = 'hd:presence:tickets';
const TYPING_MS = 5000;

/** Who is looking at / typing in a ticket. Redis holds it; entries expire by TTL, so crashed clients vanish. */
export const createPresence = (redis: Redis, ttlMs: number) => {
  const read = async (ticketId: string): Promise<Map<string, PresenceEntry>> => {
    const raw = await redis.hgetall(KEY(ticketId));
    return new Map(Object.entries(raw).map(([sid, v]) => [sid, JSON.parse(v) as PresenceEntry]));
  };

  const viewersOf = (entries: Map<string, PresenceEntry>, nowMs: number): Viewer[] => {
    const byUser = new Map<string, Viewer>();
    for (const e of entries.values()) {
      if (nowMs - e.seenAt > ttlMs) continue;
      const state = e.state === 'typing' && nowMs - e.typingAt < TYPING_MS ? 'typing' : 'viewing';
      const prev = byUser.get(e.userId);
      if (prev === undefined || state === 'typing')
        byUser.set(e.userId, { userId: e.userId, name: e.name, state });
    }
    return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    heartbeat: async (
      ticketId: string,
      socketId: string,
      who: { userId: string; name: string },
      state: 'viewing' | 'typing',
      nowMs: number,
    ): Promise<void> => {
      const entry: PresenceEntry = {
        ...who,
        state,
        seenAt: nowMs,
        typingAt: state === 'typing' ? nowMs : 0,
      };
      await redis
        .multi()
        .hset(KEY(ticketId), socketId, JSON.stringify(entry))
        .pexpire(KEY(ticketId), ttlMs * 3)
        .sadd(ACTIVE, ticketId)
        .exec();
    },
    remove: async (ticketId: string, socketId: string): Promise<void> => {
      await redis.hdel(KEY(ticketId), socketId);
    },
    viewers: async (ticketId: string, nowMs: number): Promise<Viewer[]> =>
      viewersOf(await read(ticketId), nowMs),
    /** Deletes expired entries; returns the tickets whose viewer list changed so they can be re-broadcast. */
    reap: async (nowMs: number): Promise<string[]> => {
      const changed: string[] = [];
      for (const ticketId of await redis.smembers(ACTIVE)) {
        const entries = await read(ticketId);
        const expired = [...entries]
          .filter(([, e]) => nowMs - e.seenAt > ttlMs)
          .map(([sid]) => sid);
        if (expired.length > 0) {
          await redis.hdel(KEY(ticketId), ...expired);
          changed.push(ticketId);
        }
        if (entries.size === expired.length) await redis.srem(ACTIVE, ticketId);
      }
      return changed;
    },
  };
};

export type Presence = ReturnType<typeof createPresence>;
export const presenceRoom = rooms.ticketStaff;
