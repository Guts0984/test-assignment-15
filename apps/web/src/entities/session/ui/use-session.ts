'use client';
import { useSyncExternalStore } from 'react';
import { sessionStore, type SessionState } from '../model/session-store';

export const useSession = (): SessionState =>
  useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get);
