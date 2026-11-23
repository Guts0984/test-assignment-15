import type { Db } from '@helpdesk/core';
import {
  err,
  ok,
  type Clock,
  type Membership,
  type Principal,
  type Result,
} from '@helpdesk/shared';
import { resolveTicketLink } from '../auth/link-tokens';
import { verifyAccessToken } from '../auth/domain/jwt';
import { findUserById, loadMemberships, sessionActive } from '../auth/repo/auth-repo';

export type SocketIdentity =
  | {
      readonly kind: 'staff';
      readonly userId: string;
      readonly name: string;
      readonly principal: Principal;
      readonly version: number;
      readonly sessionId: string;
    }
  | {
      readonly kind: 'customer';
      readonly ticketId: string;
      readonly customerId: string;
      readonly principal: Principal;
    };

export type SocketAuthDeps = { readonly db: Db; readonly clock: Clock; readonly jwtSecret: string };

/** Same checks as the HTTP guard, applied to the Socket.IO handshake. */
export const authenticateSocket = async (
  d: SocketAuthDeps,
  auth: unknown,
): Promise<Result<SocketIdentity, 'UNAUTHORIZED' | 'LINK_INVALID'>> => {
  const a = typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>) : {};
  if (typeof a['ticketToken'] === 'string') {
    const link = await resolveTicketLink(d.db, a['ticketToken'], d.clock.now());
    if (!link.ok) return err('LINK_INVALID');
    return ok({
      kind: 'customer',
      ticketId: link.value.ticketId,
      customerId: link.value.customerId,
      principal: {
        kind: 'customer',
        customerId: link.value.customerId,
        ticketId: link.value.ticketId,
      },
    });
  }
  if (typeof a['token'] !== 'string') return err('UNAUTHORIZED');
  const verified = await verifyAccessToken(d.jwtSecret, a['token'], d.clock.now());
  if (!verified.ok) return err('UNAUTHORIZED');
  const identity = await refreshStaffIdentity(
    d.db,
    verified.value.userId,
    verified.value.version,
    verified.value.sessionId,
  );
  return identity === null ? err('UNAUTHORIZED') : ok(identity);
};

/** Re-reads an account and its teams; null when it was disabled or its token version moved on (logout, password change). */
export const refreshStaffIdentity = async (
  db: Db,
  userId: string,
  version: number,
  sessionId: string,
): Promise<Extract<SocketIdentity, { kind: 'staff' }> | null> => {
  const user = await findUserById(db, userId);
  if (
    user === null ||
    !user.isActive ||
    user.tokenVersion !== version ||
    !(await sessionActive(db, sessionId))
  )
    return null;
  const principal: Principal =
    user.role === 'admin'
      ? { kind: 'admin', userId: user.id }
      : {
          kind: 'staff',
          userId: user.id,
          memberships: (await loadMemberships(db, user.id)) as readonly Membership[],
        };
  return {
    kind: 'staff',
    userId: user.id,
    name: user.name,
    principal,
    version: user.tokenVersion,
    sessionId,
  };
};
