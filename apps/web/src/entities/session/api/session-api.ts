import { api, refreshSession, tokenStore, unwrap, type UserView } from '@/shared/api';
import { sessionStore } from '../model/session-store';

/** Restores the session from the refresh cookie (called once on load). */
export const restoreSession = async (): Promise<void> => {
  const ok = await refreshSession();
  if (!ok) return sessionStore.set({ status: 'anonymous', user: null });
  try {
    const user = await unwrap<UserView>(api.GET('/api/v1/auth/me'));
    sessionStore.set({ status: 'authenticated', user });
  } catch {
    sessionStore.set({ status: 'anonymous', user: null });
  }
};

export const login = async (email: string, password: string): Promise<void> => {
  const r = await unwrap<{ accessToken: string; user: UserView }>(
    api.POST('/api/v1/auth/login', { body: { email, password } }),
  );
  tokenStore.set(r.accessToken);
  sessionStore.set({ status: 'authenticated', user: r.user });
};

export const logout = async (): Promise<void> => {
  await api.POST('/api/v1/auth/logout').catch(() => undefined);
  tokenStore.set(null);
  sessionStore.set({ status: 'anonymous', user: null });
};
