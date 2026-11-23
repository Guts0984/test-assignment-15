import { randomUUID } from 'node:crypto';
import { err, ok, type Clock, type Result, type UserView } from '@helpdesk/shared';
import type { Db } from '@helpdesk/core';
import { verifyPassword } from '../../infra/password';
import { hashToken, randomToken } from './domain/crypto';
import { signAccessToken } from './domain/jwt';
import {
  bumpTokenVersion,
  consumeRefreshToken,
  findRefreshToken,
  findUserByEmail,
  findUserById,
  insertRefreshToken,
  loadUserView,
  revokeFamily,
} from './repo/auth-repo';

export type AuthDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly jwtSecret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlDays: number;
  /** Verified against when the email is unknown, so timing does not reveal which emails exist. */
  readonly dummyHash: string;
};

export type Session = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly user: UserView;
};

export type AuthFailure = 'INVALID_CREDENTIALS' | 'INVALID_REFRESH' | 'REFRESH_REUSED';

const DAY_MS = 86_400_000;

/** Authentication use-cases as plain functions over injected dependencies. */
export const createAuth = (d: AuthDeps) => {
  const issue = async (
    userId: string,
    version: number,
    role: 'admin' | 'staff',
    familyId: string,
    now: Date,
  ): Promise<Result<Session, AuthFailure>> => {
    const user = await loadUserView(d.db, userId);
    if (user === null) return err('INVALID_REFRESH');
    const refreshToken = randomToken();
    await insertRefreshToken(d.db, {
      userId,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + d.refreshTtlDays * DAY_MS),
      now,
    });
    const accessToken = await signAccessToken(
      d.jwtSecret,
      { userId, version, role },
      now,
      d.accessTtlSeconds,
    );
    return ok({ accessToken, refreshToken, expiresInSeconds: d.accessTtlSeconds, user });
  };

  return {
    login: async (email: string, password: string): Promise<Result<Session, AuthFailure>> => {
      const now = d.clock.now();
      const user = await findUserByEmail(d.db, email);
      const valid = await verifyPassword(user?.passwordHash ?? d.dummyHash, password);
      if (user === null || !valid || !user.isActive) return err('INVALID_CREDENTIALS');
      return issue(user.id, user.tokenVersion, user.role, randomUUID(), now);
    },

    /** Rotates the refresh token. A token that was already used signals theft: the whole family is revoked. */
    refresh: async (token: string): Promise<Result<Session, AuthFailure>> => {
      const now = d.clock.now();
      const hash = hashToken(token);
      const consumed = await consumeRefreshToken(d.db, hash, now);
      if (consumed === null) {
        const known = await findRefreshToken(d.db, hash);
        if (known !== null) {
          await revokeFamily(d.db, known.familyId, now);
          return err(known.usedAt !== null ? 'REFRESH_REUSED' : 'INVALID_REFRESH');
        }
        return err('INVALID_REFRESH');
      }
      const user = await findUserById(d.db, consumed.userId);
      if (user === null || !user.isActive) {
        await revokeFamily(d.db, consumed.familyId, now);
        return err('INVALID_REFRESH');
      }
      return issue(user.id, user.tokenVersion, user.role, consumed.familyId, now);
    },

    /** Revokes the refresh family and invalidates outstanding access tokens by bumping the user's token version. */
    logout: async (token: string | null): Promise<void> => {
      if (token === null) return;
      const known = await findRefreshToken(d.db, hashToken(token));
      if (known === null) return;
      const now = d.clock.now();
      await revokeFamily(d.db, known.familyId, now);
      await bumpTokenVersion(d.db, known.userId);
    },

    me: (userId: string): Promise<UserView | null> => loadUserView(d.db, userId),
  };
};

export type AuthUseCases = ReturnType<typeof createAuth>;
