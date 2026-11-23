import { io, type Socket } from 'socket.io-client';
import { clientEnv } from '../config/env.client';
import { clockStore, skewFrom } from '../lib/server-clock';

export type RealtimeConnection = { readonly socket: Socket; readonly close: () => void };

/** One authenticated WebSocket (no sticky sessions needed). Reconnects forever; the server clock is re-synced on every connect. */
export const connectRealtime = (
  auth: () => { token: string } | { ticketToken: string },
  /** Called when the server refuses the handshake (an expired token): refresh the session, true to try again. */
  onRefused?: () => Promise<boolean>,
): RealtimeConnection => {
  const socket = io({
    path: clientEnv.NEXT_PUBLIC_SOCKET_PATH,
    transports: ['websocket'],
    // A function, so every reconnect sends the current access token instead of the one from the first connect.
    auth: (cb) => cb(auth()),
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  // Socket.IO does not retry after a refused handshake, so a reconnect with an expired token would stay down for good.
  let retrying = false;
  socket.on('connect_error', () => {
    if (onRefused === undefined || retrying || socket.active) return;
    retrying = true;
    void onRefused()
      .then((ok) => {
        if (ok) socket.connect();
      })
      .finally(() => {
        setTimeout(() => {
          retrying = false;
        }, 2000);
      });
  });
  socket.on('time:sync', (p: { now: string }) => {
    const skew = skewFrom(p.now, Date.now());
    if (skew !== null) clockStore.setSkew(skew);
  });
  return { socket, close: () => void socket.close() };
};
