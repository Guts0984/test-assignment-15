import { randomUUID } from 'node:crypto';

export type InboundMailInput = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly {
    readonly filename: string;
    readonly contentBase64: string;
    readonly contentType?: string;
  }[];
};

const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
const bracket = (id: string): string => (id.startsWith('<') ? id : `<${id}>`);

/** Builds a raw RFC 822 message. Header values are stripped of line breaks, so inputs cannot inject headers. */
export const composeRaw = (
  m: InboundMailInput,
  domain: string,
): { raw: Buffer; messageId: string } => {
  const messageId = m.messageId ?? `${randomUUID()}@${domain}`;
  const extra = Object.entries(m.headers ?? {}).map(
    ([k, v]) => `${clean(k).replace(/[^A-Za-z0-9-]/g, '')}: ${clean(v)}`,
  );
  const head = [
    `From: ${clean(m.from)}`,
    `To: ${clean(m.to)}`,
    `Subject: ${clean(m.subject)}`,
    `Message-ID: ${bracket(messageId)}`,
    `Date: ${new Date().toUTCString()}`,
    ...(m.inReplyTo === undefined ? [] : [`In-Reply-To: ${bracket(clean(m.inReplyTo))}`]),
    ...(m.references === undefined || m.references.length === 0
      ? []
      : [`References: ${m.references.map((r) => bracket(clean(r))).join(' ')}`]),
    ...extra,
    'MIME-Version: 1.0',
  ];
  const hasCustomType = Object.keys(m.headers ?? {}).some(
    (k) => k.toLowerCase() === 'content-type',
  );
  if (hasCustomType) return { raw: Buffer.from([...head, '', m.text, ''].join('\r\n')), messageId };
  if (m.attachments === undefined || m.attachments.length === 0) {
    return {
      raw: Buffer.from(
        [
          ...head,
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          m.text,
          '',
        ].join('\r\n'),
      ),
      messageId,
    };
  }
  const boundary = `stub-${randomUUID()}`;
  const parts = [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', m.text];
  for (const a of m.attachments) {
    const name = clean(a.filename).replace(/"/g, '');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${clean(a.contentType ?? 'application/octet-stream')}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      a.contentBase64,
    );
  }
  parts.push(`--${boundary}--`, '');
  return {
    raw: Buffer.from(
      [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n'),
    ),
    messageId,
  };
};
