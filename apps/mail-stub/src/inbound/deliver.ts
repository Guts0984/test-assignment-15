import { createHmac } from 'node:crypto';

/** Same scheme the api verifies: `t=<unix>,v1=<hmac-sha256 of "<t>." + raw body>`. */
export const signRaw = (secret: string, unixSeconds: number, raw: Buffer): string =>
  `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.`).update(raw).digest('hex')}`;

export type DeliveryResult = { readonly status: number; readonly body: string };

export type Deliverer = {
  /** Posts one raw mail to the system's inbound webhook; in chaos mode the same bytes are posted twice at once. */
  readonly deliver: (
    mailbox: string,
    raw: Buffer,
    duplicate: boolean,
  ) => Promise<readonly DeliveryResult[]>;
};

export const createDeliverer = (o: {
  url: string;
  secret: string;
  now?: () => number;
}): Deliverer => {
  const one = async (mailbox: string, raw: Buffer): Promise<DeliveryResult> => {
    const t = Math.floor((o.now?.() ?? Date.now()) / 1000);
    try {
      const res = await fetch(o.url, {
        method: 'POST',
        headers: {
          'content-type': 'message/rfc822',
          'x-envelope-to': mailbox,
          'x-inbound-signature': signRaw(o.secret, t, raw),
        },
        body: raw,
      });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      return { status: 0, body: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    deliver: (mailbox, raw, duplicate) =>
      Promise.all(Array.from({ length: duplicate ? 2 : 1 }, () => one(mailbox, raw))),
  };
};
