import type { Db, Queryable } from '@helpdesk/core';
import { err, ok, type Result } from '@helpdesk/shared';
import { hashToken, randomToken } from './domain/crypto';

const DAY_MS = 86_400_000;

export type LinkFailure = 'LINK_INVALID' | 'LINK_EXPIRED' | 'LINK_REVOKED';
export type LinkScope = {
  readonly linkId: string;
  readonly ticketId: string;
  readonly customerId: string;
};

/** Creates a magic link for exactly one ticket; the raw token is returned once and only its hash is stored. */
export const createTicketLink = async (
  db: Queryable,
  o: { ticketId: string; now: Date; ttlDays: number },
): Promise<string> => {
  const token = randomToken();
  await db.ticketAccessToken.create({
    data: {
      ticketId: o.ticketId,
      tokenHash: hashToken(token),
      expiresAt: new Date(o.now.getTime() + o.ttlDays * DAY_MS),
      createdAt: o.now,
    },
  });
  return token;
};

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const resolveTicketLink = async (
  db: Db,
  token: string,
  now: Date,
): Promise<Result<LinkScope, LinkFailure>> => {
  if (!TOKEN_SHAPE.test(token)) return err('LINK_INVALID');
  const row = await db.ticketAccessToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      ticketId: true,
      expiresAt: true,
      revokedAt: true,
      ticket: { select: { customerId: true, mergedIntoId: true } },
    },
  });
  if (row === null) return err('LINK_INVALID');
  if (row.revokedAt !== null || row.ticket.mergedIntoId !== null) return err('LINK_REVOKED');
  if (row.expiresAt.getTime() <= now.getTime()) return err('LINK_EXPIRED');
  return ok({ linkId: row.id, ticketId: row.ticketId, customerId: row.ticket.customerId });
};

/** Revokes every link of a ticket (called when it is merged into another one). */
export const revokeTicketLinks = async (
  db: Queryable,
  ticketId: string,
  now: Date,
): Promise<void> => {
  await db.ticketAccessToken.updateMany({
    where: { ticketId, revokedAt: null },
    data: { revokedAt: now },
  });
};
