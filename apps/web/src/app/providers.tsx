'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { restoreSession, sessionStore, useSession } from '@/entities/session';
import { tokenStore } from '@/shared/api';
import { isNewer } from '@/shared/lib';
import { connectRealtime, SocketContext, type SocketContextValue } from '@/shared/socket';

const makeClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } },
  });

/** Opens the staff socket after login. Events are applied only when newer than what was already seen, then the lists refetch. */
function RealtimeBridge({ children, client }: { children: ReactNode; client: QueryClient }) {
  const session = useSession();
  const [value, setValue] = useState<SocketContextValue>({ socket: null, connected: false });
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    const token = tokenStore.get();
    if (session.status !== 'authenticated' || token === null) {
      setValue({ socket: null, connected: false });
      return;
    }
    const conn = connectRealtime({ token });
    const { socket } = conn;
    let first = true;
    const refresh = (ticketId?: string): void => {
      void client.invalidateQueries({ queryKey: ['queue'] });
      void client.invalidateQueries({ queryKey: ['unassigned'] });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
      void client.invalidateQueries({ queryKey: ['notifications'] });
      void client.invalidateQueries({ queryKey: ['search'] });
      if (ticketId !== undefined) void client.invalidateQueries({ queryKey: ['ticket', ticketId] });
    };
    const onTicket = (p: { ticket: { id: string; version: number } }): void => {
      if (!isNewer(p.ticket.version, seen.current.get(p.ticket.id))) return; // a late, older event must not win
      seen.current.set(p.ticket.id, p.ticket.version);
      refresh(p.ticket.id);
    };
    socket.on('connect', () => {
      setValue({ socket, connected: true });
      if (!first) void client.invalidateQueries(); // reconnected: catch up on everything that was missed
      first = false;
    });
    socket.on('disconnect', () => setValue({ socket, connected: false }));
    socket.on('ticket.created', onTicket);
    socket.on('ticket.updated', onTicket);
    socket.on('message.created', (p: { ticket: { id: string; version: number } }) => {
      seen.current.set(p.ticket.id, Math.max(p.ticket.version, seen.current.get(p.ticket.id) ?? 0));
      refresh(p.ticket.id);
    });
    setValue({ socket, connected: socket.connected });
    return () => {
      conn.close();
      setValue({ socket: null, connected: false });
    };
  }, [session.status, client]);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  useEffect(() => {
    tokenStore.onRefreshFailed(() => sessionStore.set({ status: 'anonymous', user: null }));
    void restoreSession();
  }, []);
  return (
    <QueryClientProvider client={client}>
      <RealtimeBridge client={client}>{children}</RealtimeBridge>
    </QueryClientProvider>
  );
}
