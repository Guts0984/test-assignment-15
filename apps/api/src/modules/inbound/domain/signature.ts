import { createHmac, timingSafeEqual } from 'node:crypto';

/** `X-Inbound-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>." + raw body>` */
export const signInbound = (secret: string, unixSeconds: number, body: Buffer): string => {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.`).update(body).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
};

export type SignatureCheck = 'ok' | 'malformed' | 'stale' | 'mismatch';

export const verifyInbound = (
  secret: string,
  header: string | undefined,
  body: Buffer,
  nowMs: number,
  toleranceSeconds: number,
): SignatureCheck => {
  const m = header === undefined ? null : /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (m?.[1] === undefined || m[2] === undefined) return 'malformed';
  const t = Number(m[1]);
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) return 'stale';
  const expected = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'ok' : 'mismatch';
};
