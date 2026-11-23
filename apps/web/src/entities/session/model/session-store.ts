import type { UserView } from '@/shared/api';

export type SessionState = {
  readonly status: 'loading' | 'anonymous' | 'authenticated';
  readonly user: UserView | null;
};

const state = {
  value: { status: 'loading', user: null } as SessionState,
  listeners: new Set<() => void>(),
};

export const sessionStore = {
  get: (): SessionState => state.value,
  set: (v: SessionState): void => {
    state.value = v;
    for (const l of state.listeners) l();
  },
  subscribe: (l: () => void): (() => void) => {
    state.listeners.add(l);
    return () => state.listeners.delete(l);
  },
};

export const isLeadOrAdmin = (u: UserView | null): boolean =>
  u !== null && (u.role === 'admin' || u.memberships.some((m) => m.role === 'lead'));

export const isAdmin = (u: UserView | null): boolean => u?.role === 'admin';
