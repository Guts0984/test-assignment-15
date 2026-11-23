import type { Db, Queryable } from '@helpdesk/core';
import type { UserView } from '@helpdesk/shared';

export type UserRow = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly role: 'admin' | 'staff';
  readonly isActive: boolean;
  readonly tokenVersion: number;
};

export const findUserByEmail = (db: Queryable, email: string): Promise<UserRow | null> =>
  db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      role: true,
      isActive: true,
      tokenVersion: true,
    },
  }) as Promise<UserRow | null>;

export const findUserById = (db: Queryable, id: string): Promise<UserRow | null> =>
  db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      role: true,
      isActive: true,
      tokenVersion: true,
    },
  }) as Promise<UserRow | null>;

export const loadUserView = async (db: Queryable, id: string): Promise<UserView | null> => {
  const u = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      onShift: true,
      ticketLimit: true,
      languages: true,
      memberships: { select: { teamId: true, role: true } },
    },
  });
  return u === null ? null : (u as UserView);
};

export const loadMemberships = (db: Queryable, userId: string) =>
  db.teamMember.findMany({ where: { userId }, select: { teamId: true, role: true } });

export const bumpTokenVersion = async (db: Queryable, userId: string): Promise<void> => {
  await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
};

export const insertRefreshToken = async (
  db: Queryable,
  r: { userId: string; familyId: string; tokenHash: string; expiresAt: Date; now: Date },
): Promise<void> => {
  await db.refreshToken.create({
    data: {
      userId: r.userId,
      familyId: r.familyId,
      tokenHash: r.tokenHash,
      expiresAt: r.expiresAt,
      createdAt: r.now,
    },
  });
};

/** Atomically marks a still-valid refresh token as used; only one concurrent caller can win. */
export const consumeRefreshToken = async (
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<{ userId: string; familyId: string } | null> => {
  const rows = await db.$queryRaw<{ user_id: string; family_id: string }[]>`
    UPDATE refresh_tokens SET used_at = ${now}
     WHERE token_hash = ${tokenHash} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}
    RETURNING user_id, family_id`;
  const row = rows[0];
  return row === undefined ? null : { userId: row.user_id, familyId: row.family_id };
};

export const findRefreshToken = (db: Queryable, tokenHash: string) =>
  db.refreshToken.findUnique({
    where: { tokenHash },
    select: { familyId: true, userId: true, usedAt: true, revokedAt: true, expiresAt: true },
  });

export const revokeFamily = async (db: Queryable, familyId: string, now: Date): Promise<void> => {
  await db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
};
