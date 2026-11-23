import { describe, expect, it } from 'vitest';
import {
  canAdminister,
  canReassignAnyone,
  canViewInternalNotes,
  canViewReports,
  canViewTeamDashboard,
  canViewTicket,
  canWorkOnTicket,
  leadTeamIds,
  visibleTeamIds,
  type Principal,
  type TicketScope,
} from './permissions';

const ticket: TicketScope = { ticketId: 't1', teamId: 'A', customerId: 'c1' };
const admin: Principal = { kind: 'admin', userId: 'u0' };
const agentA: Principal = {
  kind: 'staff',
  userId: 'u1',
  memberships: [{ teamId: 'A', role: 'agent' }],
};
const leadA: Principal = {
  kind: 'staff',
  userId: 'u2',
  memberships: [{ teamId: 'A', role: 'lead' }],
};
const agentB: Principal = {
  kind: 'staff',
  userId: 'u3',
  memberships: [{ teamId: 'B', role: 'agent' }],
};
const leadB: Principal = {
  kind: 'staff',
  userId: 'u4',
  memberships: [{ teamId: 'B', role: 'lead' }],
};
const own: Principal = { kind: 'customer', customerId: 'c1', ticketId: 't1' };
const otherTicketLink: Principal = { kind: 'customer', customerId: 'c1', ticketId: 't2' };
const otherCustomer: Principal = { kind: 'customer', customerId: 'c2', ticketId: 't1' };

describe('permissions matrix', () => {
  it.each([
    ['admin', admin, true],
    ['agent of the team', agentA, true],
    ['lead of the team', leadA, true],
    ['agent of another team', agentB, false],
    ['lead of another team', leadB, false],
    ['customer with the matching link', own, true],
    ['customer link for another ticket', otherTicketLink, false],
    ['other customer', otherCustomer, false],
  ] as const)('view ticket: %s -> %s', (_n, p, expected) => {
    expect(canViewTicket(p, ticket)).toBe(expected);
  });

  it('customers never see internal notes or work on tickets', () => {
    expect(canViewInternalNotes(own, ticket)).toBe(false);
    expect(canWorkOnTicket(own, ticket)).toBe(false);
    expect(canViewInternalNotes(agentA, ticket)).toBe(true);
    expect(canViewInternalNotes(agentB, ticket)).toBe(false);
  });

  it('only leads of the team and admins reassign anyone, see the dashboard and reports', () => {
    for (const fn of [canReassignAnyone, canViewTeamDashboard, canViewReports]) {
      expect(fn(admin, 'A')).toBe(true);
      expect(fn(leadA, 'A')).toBe(true);
      expect(fn(agentA, 'A')).toBe(false);
      expect(fn(leadB, 'A')).toBe(false);
      expect(fn(own, 'A')).toBe(false);
    }
  });

  it('only admins administer', () => {
    expect(canAdminister(admin)).toBe(true);
    for (const p of [agentA, leadA, own]) expect(canAdminister(p)).toBe(false);
  });

  it('scopes team lists', () => {
    expect(visibleTeamIds(admin)).toBeNull();
    expect(visibleTeamIds(agentA)).toEqual(['A']);
    expect(visibleTeamIds(own)).toEqual([]);
    expect(leadTeamIds(leadA)).toEqual(['A']);
    expect(leadTeamIds(agentA)).toEqual([]);
    expect(leadTeamIds(admin)).toBeNull();
  });
});
