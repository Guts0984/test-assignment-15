import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url: the opaque value handed to clients. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** Only the SHA-256 of a token is ever stored. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time string comparison that is safe for unequal lengths. */
export const safeEqual = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
};
