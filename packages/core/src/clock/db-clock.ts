import type { Clock } from '@helpdesk/shared';
import { Client } from 'pg';
import type { Db } from '../db/client';

export type DbClock = Clock & {
  /** Current offset in milliseconds. */
  readonly offsetMs: () => number;
  readonly generation: () => number;
  /** Re-reads the shared offset right now. */
  readonly refresh: () => Promise<void>;
  /** Sets the shared offset in Postgres; every api and worker copy picks it up. */
  readonly setOffsetMs: (ms: number) => Promise<void>;
  readonly stop: () => Promise<void>;
};

type ClockOptions = {
  readonly base: Clock;
  readonly db: Db;
  /** Connection string for the LISTEN connection; omitted -> polling only. */
  readonly listenUrl?: string;
  readonly pollMs?: number;
  /** Called after the offset or generation changed. */
  readonly onChange?: (offsetMs: number, generation: number) => void;
};

/**
 * Controllable clock shared by every process through one Postgres row.
 * Only created when TEST_CLOCK_ENABLED=true; otherwise processes use the plain system clock.
 */
export const createDbClock = async (o: ClockOptions): Promise<DbClock> => {
  const state = { offset: 0, generation: -1, stopped: false };
  const read = async (): Promise<void> => {
    const rows = await o.db.$queryRaw<
      { offset_ms: bigint; generation: number }[]
    >`SELECT offset_ms, generation FROM app_clock WHERE id = 1`;
    const row = rows[0];
    if (row === undefined) return;
    const offset = Number(row.offset_ms);
    if (offset !== state.offset || row.generation !== state.generation) {
      state.offset = offset;
      state.generation = row.generation;
      o.onChange?.(offset, row.generation);
    }
  };
  await read();

  const timer = setInterval(() => {
    if (!state.stopped) void read().catch(() => undefined);
  }, o.pollMs ?? 1000);
  timer.unref();

  const listener = o.listenUrl === undefined ? null : new Client({ connectionString: o.listenUrl });
  if (listener !== null) {
    listener.on('error', () => undefined);
    listener.on('notification', () => void read().catch(() => undefined));
    try {
      await listener.connect();
      await listener.query('LISTEN app_clock');
    } catch {
      /* polling keeps the clock correct if LISTEN is unavailable */
    }
  }

  return {
    now: () => new Date(o.base.now().getTime() + state.offset),
    offsetMs: () => state.offset,
    generation: () => state.generation,
    refresh: read,
    setOffsetMs: async (ms) => {
      await o.db
        .$executeRaw`UPDATE app_clock SET offset_ms = ${ms}::bigint, generation = generation + 1 WHERE id = 1`;
      await read();
    },
    stop: async () => {
      state.stopped = true;
      clearInterval(timer);
      await listener?.end().catch(() => undefined);
    },
  };
};
