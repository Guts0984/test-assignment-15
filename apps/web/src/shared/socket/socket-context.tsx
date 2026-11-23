'use client';
import { createContext, useContext } from 'react';
import type { Socket } from 'socket.io-client';

export type SocketContextValue = { readonly socket: Socket | null; readonly connected: boolean };

export const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export const useSocket = (): SocketContextValue => useContext(SocketContext);
