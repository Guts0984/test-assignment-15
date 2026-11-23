import { io, type Socket } from 'socket.io-client';

export type TestSocket = {
  readonly socket: Socket;
  readonly events: { event: string; payload: unknown; at: number }[];
  readonly connected: () => Promise<void>;
  readonly next: <T = unknown>(event: string, ms?: number) => Promise<T>;
  readonly emit: <T = unknown>(event: string, payload?: unknown) => Promise<T>;
  readonly close: () => void;
  /** Kills the TCP connection without a Socket.IO goodbye, like a crashed browser tab. */
  readonly drop: () => void;
};

/** A real Socket.IO client bound to one api copy; it records every server event with its arrival time. */
export const connectSocket = (
  baseUrl: string,
  auth: Record<string, unknown> | undefined,
  extra: { sourceIp?: string } = {},
): TestSocket => {
  const socket = io(baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: auth ?? {},
    reconnection: false,
    forceNew: true,
    ...(extra.sourceIp === undefined ? {} : { localAddress: extra.sourceIp }),
  } as never);
  const events: { event: string; payload: unknown; at: number }[] = [];
  socket.onAny((event: string, payload: unknown) =>
    events.push({ event, payload, at: performance.now() }),
  );
  const waiters: { event: string; resolve: (v: unknown) => void }[] = [];
  socket.onAny((event: string, payload: unknown) => {
    for (const w of [...waiters])
      if (w.event === event) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(payload);
      }
  });
  return {
    socket,
    events,
    connected: () =>
      new Promise<void>((resolve, reject) => {
        if (socket.connected) return resolve();
        socket.once('connect', () => resolve());
        socket.once('connect_error', (e) => reject(e));
      }),
    next: <T>(event: string, ms = 5000) =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms`)), ms);
        waiters.push({
          event,
          resolve: (v) => {
            clearTimeout(t);
            resolve(v as T);
          },
        });
      }),
    emit: <T>(event: string, payload?: unknown) =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no ack for "${event}"`)), 5000);
        socket.emit(event, payload, (r: T) => {
          clearTimeout(t);
          resolve(r);
        });
      }),
    close: () => {
      socket.close();
    },
    drop: () => {
      (
        socket.io as unknown as {
          engine: {
            close: () => void;
            transport: { ws?: { terminate?: () => void; close: () => void } };
          };
        }
      ).engine.transport.ws?.terminate?.();
    },
  };
};

export const rejectedWith = (
  baseUrl: string,
  auth: Record<string, unknown> | undefined,
): Promise<string> =>
  new Promise((resolve) => {
    const s = connectSocket(baseUrl, auth);
    s.socket.once('connect', () => {
      s.close();
      resolve('CONNECTED');
    });
    s.socket.once('connect_error', (e) => {
      s.close();
      resolve(e.message);
    });
  });
