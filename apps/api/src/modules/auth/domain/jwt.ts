import { SignJWT, jwtVerify } from 'jose';
import { err, ok, type Result } from '@helpdesk/shared';

const ISSUER = 'helpdesk';
const AUDIENCE = 'helpdesk-api';

export type AccessClaims = {
  readonly userId: string;
  readonly version: number;
  readonly role: 'admin' | 'staff';
};
export type JwtFailure = 'invalid' | 'expired';

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export const signAccessToken = (
  secret: string,
  claims: AccessClaims,
  now: Date,
  ttlSeconds: number,
): Promise<string> => {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ ver: claims.version, role: claims.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(keyOf(secret));
};

/** Pins the algorithm, issuer and audience; the time check uses the injected clock. */
export const verifyAccessToken = async (
  secret: string,
  token: string,
  now: Date,
): Promise<Result<AccessClaims, JwtFailure>> => {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: now,
      requiredClaims: ['sub', 'exp', 'iat', 'nbf'],
    });
    const { sub, ver, role } = payload as { sub?: unknown; ver?: unknown; role?: unknown };
    if (
      typeof sub !== 'string' ||
      typeof ver !== 'number' ||
      (role !== 'admin' && role !== 'staff')
    ) {
      return err('invalid');
    }
    return ok({ userId: sub, version: ver, role });
  } catch (e) {
    const code = (e as { code?: string }).code;
    return err(code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid');
  }
};
