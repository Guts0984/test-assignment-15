export type HeaderMap = Readonly<Record<string, string | readonly string[] | undefined>>;

const first = (v: string | readonly string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : v?.[0];

/** Looks up a header case-insensitively. */
export const getHeader = (headers: HeaderMap, name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return first(v);
  }
  return undefined;
};

export const normalizeEmail = (raw: string): string => {
  const m = /<([^<>]+)>/.exec(raw);
  return (m?.[1] ?? raw).trim().toLowerCase();
};

const MESSAGE_ID_MAX = 998;

/** Extracts message ids (`<id>`) from In-Reply-To/References, newest last in the source. Garbage is skipped. */
export const parseMessageIds = (header: string | undefined): readonly string[] => {
  if (header === undefined) return [];
  const ids: string[] = [];
  for (const m of header.matchAll(/<([^<>\s\x00-\x1f]{1,998})>/g)) {
    const id = m[1];
    if (id !== undefined && id.includes('@') && id.length <= MESSAGE_ID_MAX) ids.push(id);
  }
  return ids;
};

/** Ticket number from a subject like "Re: Fwd: [#100123] Printer" (first tag wins). */
export const ticketNumberFromSubject = (subject: string): number | null => {
  const m = /\[#(\d{1,12})\]/.exec(subject);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
};

/** Removes control characters so a value can never inject a header line. */
export const stripControlChars = (s: string): string =>
  s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim();

export const hasLineBreak = (s: string): boolean => /[\r\n\u2028\u2029]/.test(s);

export const outboundSubject = (ticketNumber: number, subject: string): string => {
  const clean = stripControlChars(subject).slice(0, 300);
  return ticketNumberFromSubject(clean) === ticketNumber ? clean : `[#${ticketNumber}] ${clean}`;
};

export type AutomatedKind = 'autoreply' | 'bounce';
export type AutomatedVerdict = { readonly kind: AutomatedKind; readonly reason: string } | null;

/**
 * Decides whether a message is machine-generated. Such mail never creates or reopens a ticket
 * and never triggers an acknowledgement, which prevents mail loops.
 */
export const detectAutomated = (
  headers: HeaderMap,
  envelope: { readonly returnPath?: string | null; readonly from?: string | null },
): AutomatedVerdict => {
  const contentType = (getHeader(headers, 'content-type') ?? '').toLowerCase();
  if (contentType.includes('multipart/report') && contentType.includes('delivery-status'))
    return { kind: 'bounce', reason: 'DSN content type' };
  if (contentType.includes('report-type=delivery-status'))
    return { kind: 'bounce', reason: 'DSN content type' };

  const returnPath = (
    envelope.returnPath ??
    getHeader(headers, 'return-path') ??
    undefined
  )?.trim();
  if (returnPath === '<>' || returnPath === '')
    return { kind: 'bounce', reason: 'null return path' };

  const fromLocal =
    normalizeEmail(envelope.from ?? getHeader(headers, 'from') ?? '').split('@')[0] ?? '';
  if (fromLocal === 'mailer-daemon' || fromLocal === 'postmaster')
    return { kind: 'bounce', reason: 'sender is mailer-daemon/postmaster' };

  const autoSubmitted = getHeader(headers, 'auto-submitted')?.trim().toLowerCase();
  if (autoSubmitted !== undefined && autoSubmitted !== 'no')
    return { kind: 'autoreply', reason: `Auto-Submitted: ${autoSubmitted}` };

  const precedence = getHeader(headers, 'precedence')?.trim().toLowerCase();
  if (precedence !== undefined && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence))
    return { kind: 'autoreply', reason: `Precedence: ${precedence}` };

  if (
    getHeader(headers, 'x-autoreply') !== undefined ||
    getHeader(headers, 'x-autorespond') !== undefined
  )
    return { kind: 'autoreply', reason: 'X-Autoreply/X-Autorespond' };

  // Microsoft Exchange and Outlook mark their automatic replies with X-Auto-Response-Suppress AND an "Automatic reply:"
  // subject. The header alone is not enough: many CRMs add it to ordinary human mail, asking others not to auto-reply.
  const suppress = getHeader(headers, 'x-auto-response-suppress')?.toLowerCase() ?? '';
  const subject = (getHeader(headers, 'subject') ?? '').trim();
  const autoSubject = /^(automatic reply|auto[- ]?reply|autoreply|out of office)\s*[:-]/i.test(
    subject,
  );
  if (autoSubject && suppress !== '')
    return { kind: 'autoreply', reason: 'Outlook automatic reply' };

  return null;
};
