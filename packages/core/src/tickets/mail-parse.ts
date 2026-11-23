import { createHash } from 'node:crypto';
import mailparser from 'mailparser';
import {
  err,
  getHeader,
  normalizeEmail,
  ok,
  parseMessageIds,
  stripControlChars,
  type HeaderMap,
  type Result,
} from '@helpdesk/shared';
import type { AttachmentInput } from './types';

export type ParsedMail = {
  readonly messageId: string;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly fromEmail: string;
  readonly fromName: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly AttachmentInput[];
  readonly headers: HeaderMap;
  readonly returnPath: string | null;
};

export type ParseFailure = 'MAIL_UNPARSEABLE' | 'PAYLOAD_TOO_LARGE';

const unfold = (line: string): string => line.replace(/\r?\n[ \t]+/g, ' ');

/** Parses a raw RFC 822 message. A missing Message-ID is synthesized from the bytes so redelivery still dedupes. */
export const parseRawMail = async (
  raw: Buffer,
  maxAttachmentBytes: number,
): Promise<Result<ParsedMail, ParseFailure>> => {
  let parsed;
  try {
    parsed = await mailparser.simpleParser(raw, { skipImageLinks: true, skipHtmlToText: false });
  } catch {
    return err('MAIL_UNPARSEABLE');
  }
  const from = parsed.from?.value[0];
  if (from?.address === undefined || from.address === '') return err('MAIL_UNPARSEABLE');
  const headers: Record<string, string> = {};
  for (const h of parsed.headerLines) {
    const key = h.key.toLowerCase();
    const value = unfold(h.line.slice(h.line.indexOf(':') + 1)).trim();
    headers[key] = headers[key] === undefined ? value : `${headers[key]} ${value}`;
  }
  const total = parsed.attachments.reduce((n, a) => n + a.size, 0);
  if (total > maxAttachmentBytes) return err('PAYLOAD_TOO_LARGE');
  const declared = parseMessageIds(parsed.messageId ?? getHeader(headers, 'message-id'))[0];
  const messageId =
    declared ?? `${createHash('sha256').update(raw).digest('hex')}@synthesized.invalid`;
  const fromEmail = normalizeEmail(from.address);
  return ok({
    messageId,
    inReplyTo: parseMessageIds(headers['in-reply-to']),
    references: parseMessageIds(headers['references']),
    fromEmail,
    fromName: stripControlChars(from.name ?? '') || (fromEmail.split('@')[0] ?? 'Customer'),
    subject: stripControlChars(parsed.subject ?? '').slice(0, 300),
    text: (parsed.text ?? '')
      .replace(/\u0000/g, '')
      .trim()
      .slice(0, 100_000),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      contentType: a.contentType,
      data: a.content,
    })),
    headers,
    returnPath: headers['return-path'] ?? null,
  });
};

/** Message-ID of a raw message without a full parse (used by the api to dedupe before queueing). */
export const quickMessageId = (raw: Buffer): string => {
  const headEnd = raw.indexOf('\r\n\r\n');
  const alt = raw.indexOf('\n\n');
  const end = headEnd >= 0 ? headEnd : alt >= 0 ? alt : Math.min(raw.length, 65_536);
  const head = unfold(raw.subarray(0, Math.min(end, 65_536)).toString('latin1'));
  const m = /^message-id:[ \t]*(.*)$/im.exec(head);
  const declared = parseMessageIds(m?.[1])[0];
  return declared ?? `${createHash('sha256').update(raw).digest('hex')}@synthesized.invalid`;
};
