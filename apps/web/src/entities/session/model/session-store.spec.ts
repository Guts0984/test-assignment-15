import { describe, expect, it } from 'vitest';
import type { UserView } from '@/shared/api';
import { isAdmin, isLeadOrAdmin, sessionStore } from './session-store';

const user = (over: Partial<UserView>): UserView =>
  ({
    id: 'u',
    email: 'a@b.test',
    name: 'A',
    role: 'staff',
    onShift: false,
    ticketLimit: 1,
    languages: ['en'],
    memberships: [],
    ...over,
  }) as UserView;

describe('session model', () => {
  it('knows who may see the lead and admin screens', () => {
    expect(isLeadOrAdmin(user({ role: 'admin' }))).toBe(true);
    expect(isLeadOrAdmin(user({ memberships: [{ teamId: 't', role: 'lead' }] }))).toBe(true);
    expect(isLeadOrAdmin(user({ memberships: [{ teamId: 't', role: 'agent' }] }))).toBe(false);
    expect(isLeadOrAdmin(null)).toBe(false);
    expect(isAdmin(user({ role: 'admin' }))).toBe(true);
    expect(isAdmin(user({}))).toBe(false);
  });

  it('notifies subscribers on change', () => {
    let n = 0;
    const off = sessionStore.subscribe(() => (n += 1));
    sessionStore.set({ status: 'anonymous', user: null });
    off();
    sessionStore.set({ status: 'loading', user: null });
    expect(n).toBe(1);
  });
});
