import type { MembershipRole } from '../domain/constants';

export type Membership = { readonly teamId: string; readonly role: MembershipRole };

export type Principal =
  | { readonly kind: 'admin'; readonly userId: string }
  | { readonly kind: 'staff'; readonly userId: string; readonly memberships: readonly Membership[] }
  | { readonly kind: 'customer'; readonly customerId: string; readonly ticketId: string };

export type TicketScope = {
  readonly ticketId: string;
  readonly teamId: string;
  readonly customerId: string;
};

const staffRole = (p: Principal, teamId: string): MembershipRole | null =>
  p.kind === 'staff' ? (p.memberships.find((m) => m.teamId === teamId)?.role ?? null) : null;

/** Agents, leads (of that team) and admins may see the ticket; a customer only the ticket their link names. */
export const canViewTicket = (p: Principal, t: TicketScope): boolean => {
  if (p.kind === 'admin') return true;
  if (p.kind === 'customer') return p.ticketId === t.ticketId && p.customerId === t.customerId;
  return staffRole(p, t.teamId) !== null;
};

export const isStaffLike = (p: Principal): boolean => p.kind === 'admin' || p.kind === 'staff';

/** Internal notes are visible to staff with access to the ticket and never to customers. */
export const canViewInternalNotes = (p: Principal, t: TicketScope): boolean =>
  isStaffLike(p) && canViewTicket(p, t);

/** Reply, note, status, priority, team change, merge, take and transfer-to-colleague all need ticket access. */
export const canWorkOnTicket = (p: Principal, t: TicketScope): boolean =>
  isStaffLike(p) && canViewTicket(p, t);

export const isLeadOf = (p: Principal, teamId: string): boolean =>
  p.kind === 'admin' || staffRole(p, teamId) === 'lead';

/** Reassigning a ticket held by someone else, or to any member of the team, is for leads and admins. */
export const canReassignAnyone = (p: Principal, teamId: string): boolean => isLeadOf(p, teamId);

export const canViewTeamDashboard = (p: Principal, teamId: string): boolean => isLeadOf(p, teamId);

export const canViewReports = (p: Principal, teamId: string): boolean => isLeadOf(p, teamId);

export const canAdminister = (p: Principal): boolean => p.kind === 'admin';

/** Teams whose tickets the principal may list; `null` means every team (admin). */
export const visibleTeamIds = (p: Principal): readonly string[] | null => {
  if (p.kind === 'admin') return null;
  if (p.kind === 'staff') return p.memberships.map((m) => m.teamId);
  return [];
};

export const leadTeamIds = (p: Principal): readonly string[] | null => {
  if (p.kind === 'admin') return null;
  if (p.kind === 'staff')
    return p.memberships.filter((m) => m.role === 'lead').map((m) => m.teamId);
  return [];
};
