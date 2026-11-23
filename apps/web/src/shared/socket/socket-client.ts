import { io, type Socket } from 'socket.io-client';
import { clientEnv } from '../config/env.client';
import { clockStore, skewFrom } from '../lib/server-clock';

export type RealtimeConnection = { readonly socket: Socket; readonly close: () => void };

/** One authenticated WebSocket (no sticky sessions needed). Reconnects forever; the server clock is re-synced on every connect. */
export const connectRealtime = (
  auth: { token: string } | { ticketToken: string },
): RealtimeConnection => {
  const socket = io({
    path: clientEnv.NEXT_PUBLIC_SOCKET_PATH,
    transports: ['websocket'],
    auth,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  socket.on('time:sync', (p: { now: string }) => {
    const skew = skewFrom(p.now, Date.now());
    if (skew !== null) clockStore.setSkew(skew);
  });
  return { socket, close: () => void socket.close() };
};
