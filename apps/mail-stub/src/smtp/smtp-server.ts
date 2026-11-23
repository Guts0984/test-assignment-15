import mailparser from 'mailparser';
import { SMTPServer } from 'smtp-server';
import type { Chaos } from '../chaos/chaos';
import type { Store, StoredMail } from '../store/store';

export type SmtpStats = {
  transactions: number;
  failed: number;
  delivered: number;
  /** Repeated deliveries of the same Message-ID to the same recipients that were acknowledged but not stored again. */
  duplicates: number;
};

export type SmtpDeps = {
  readonly store: Store;
  readonly chaos: Chaos;
  readonly now: () => Date;
  /** Called after a mail was accepted (for autoreply generation). */
  readonly onAccepted: (m: StoredMail) => void;
  readonly stats: SmtpStats;
  /**
   * Behave like a real mailbox provider: a repeat of a Message-ID already delivered to the same recipients is
   * acknowledged but not stored again. SMTP gives a sender no way to know whether a send that was cut off had
   * arrived, so the sender may repeat it and the receiving side is what makes delivery idempotent.
   */
  readonly dedupeMessageId: boolean;
};

const headerMap = (lines: readonly { key: string; line: string }[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const value = l.line
      .slice(l.line.indexOf(':') + 1)
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim();
    out[l.key] = out[l.key] === undefined ? value : `${out[l.key]}, ${value}`;
  }
  return out;
};

/** SMTP sink: accepts every mail, except that chaos mode answers every Nth transaction with a temporary error (451). */
export const createSmtpServer = (d: SmtpDeps): SMTPServer => {
  const delivered = new Set<string>();
  return new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    size: 25 * 1024 * 1024,
    logger: false,
    onData: (stream, session, callback) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', (e: Error) => callback(e)); // a connection cut in the middle of DATA must not take the stub down
      stream.on('end', () => {
        d.stats.transactions += 1;
        if (d.chaos.shouldFailTransaction()) {
          d.stats.failed += 1;
          const err = Object.assign(new Error('4.3.0 Temporary failure, please try again later'), {
            responseCode: 451,
          });
          callback(err);
          return;
        }
        mailparser
          .simpleParser(Buffer.concat(chunks))
          .then((p) => {
            const key = `${session.envelope.rcptTo
              .map((r) => r.address.toLowerCase())
              .sort()
              .join(',')}|${p.messageId ?? ''}`;
            if (d.dedupeMessageId && p.messageId !== undefined && delivered.has(key)) {
              d.stats.duplicates += 1;
              callback();
              return;
            }
            if (p.messageId !== undefined) delivered.add(key);
            const stored = d.store.add(
              {
                envelopeFrom:
                  session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
                envelopeTo: session.envelope.rcptTo.map((r) => r.address),
                from: p.from?.text ?? '',
                to: Array.isArray(p.to)
                  ? p.to.map((t) => t.text)
                  : p.to === undefined
                    ? []
                    : [p.to.text],
                subject: p.subject ?? '',
                messageId: p.messageId ?? null,
                headers: headerMap(p.headerLines),
                text: p.text ?? '',
                attachments: p.attachments.map((a) => ({
                  filename: a.filename ?? 'attachment',
                  size: a.size,
                })),
              },
              d.now(),
            );
            d.stats.delivered += 1;
            callback();
            d.onAccepted(stored);
          })
          .catch(() =>
            callback(
              Object.assign(new Error('5.6.0 Message could not be parsed'), { responseCode: 550 }),
            ),
          );
      });
    },
  });
};
