import { describe, expect, it } from 'vitest';
import {
  detectAutomated,
  getHeader,
  hasLineBreak,
  normalizeEmail,
  outboundSubject,
  parseMessageIds,
  stripControlChars,
  ticketNumberFromSubject,
} from './mail-headers';

describe('ticketNumberFromSubject', () => {
  it.each([
    ['[#100123] Printer', 100123],
    ['Re: Fwd: [#100123] Printer', 100123],
    ['RE: RE: [#42] x', 42],
    ['Printer [#100999]', 100999],
  ])('%s -> %s', (subject, n) => expect(ticketNumberFromSubject(subject)).toBe(n));

  it.each([
    '#100123 Printer',
    '[100123] Printer',
    '[#abc]',
    '[#]',
    '(#123)',
    '[ #123 ]',
    '[#99999999999999999999]',
  ])('ignores look-alike %s', (subject) => expect(ticketNumberFromSubject(subject)).toBeNull());

  it('takes the first tag when several are present', () => {
    expect(ticketNumberFromSubject('[#1000] and [#2000]')).toBe(1000);
  });
});

describe('parseMessageIds', () => {
  it('extracts ids from folded References, in order', () => {
    expect(parseMessageIds('<a@x.test>\r\n <b@x.test> <c@x.test>')).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
    ]);
  });
  it('skips garbage and ids without @', () => {
    expect(parseMessageIds('garbage <noat> <ok@x.test> <bad id@x.test> <>')).toEqual(['ok@x.test']);
  });
  it('rejects control characters and absurd lengths', () => {
    expect(parseMessageIds(`<a\x00b@x.test> <${'a'.repeat(1000)}@x.test>`)).toEqual([]);
  });
  it('handles a missing header', () => {
    expect(parseMessageIds(undefined)).toEqual([]);
  });
});

describe('detectAutomated', () => {
  const none = {};
  it('lets ordinary human mail through', () => {
    expect(
      detectAutomated(
        { 'Content-Type': 'text/plain', 'Auto-Submitted': 'no' },
        { from: 'Ann <ann@x.test>' },
      ),
    ).toBeNull();
  });
  it.each([
    [{ 'Auto-Submitted': 'auto-replied' }, 'autoreply'],
    [{ 'auto-submitted': 'auto-generated' }, 'autoreply'],
    [{ Precedence: 'bulk' }, 'autoreply'],
    [{ Precedence: 'JUNK' }, 'autoreply'],
    [{ Precedence: 'auto_reply' }, 'autoreply'],
    [{ 'X-Autoreply': 'yes' }, 'autoreply'],
    [{ 'X-Autorespond': 'yes' }, 'autoreply'],
    [{ 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' }, 'bounce'],
    [{ 'Return-Path': '<>' }, 'bounce'],
  ])('%j is %s', (headers, kind) => {
    expect(detectAutomated(headers, none)?.kind).toBe(kind);
  });
  it('detects the null return path from the envelope and mailer-daemon senders', () => {
    expect(detectAutomated({}, { returnPath: '<>' })?.kind).toBe('bounce');
    expect(detectAutomated({}, { from: 'MAILER-DAEMON@mx.test' })?.kind).toBe('bounce');
    expect(detectAutomated({}, { from: 'Mail Delivery <postmaster@mx.test>' })?.kind).toBe(
      'bounce',
    );
  });
  it('does not treat Precedence: first-class as automated', () => {
    expect(detectAutomated({ Precedence: 'first-class' }, none)).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes addresses', () => {
    expect(normalizeEmail('Ann Lee <Ann.Lee@Example.COM>')).toBe('ann.lee@example.com');
    expect(normalizeEmail('  X@Y.test ')).toBe('x@y.test');
  });
  it('looks headers up case-insensitively and takes the first of a list', () => {
    expect(getHeader({ 'In-Reply-To': ['<a@x>', '<b@x>'] }, 'in-reply-to')).toBe('<a@x>');
    expect(getHeader({}, 'x')).toBeUndefined();
  });
  it('strips CR/LF so a subject can never inject a header', () => {
    expect(stripControlChars('Hi\r\nBcc: evil@x.test')).toBe('Hi  Bcc: evil@x.test');
    expect(hasLineBreak('a\nb')).toBe(true);
    expect(hasLineBreak('ab')).toBe(false);
    expect(outboundSubject(100123, 'Help\r\nBcc: x@y')).not.toMatch(/[\r\n]/);
  });
  it('adds the ticket tag once', () => {
    expect(outboundSubject(100123, 'Printer')).toBe('[#100123] Printer');
    expect(outboundSubject(100123, 'Re: [#100123] Printer')).toBe('Re: [#100123] Printer');
    expect(outboundSubject(100123, 'Re: [#7] Printer')).toBe('[#100123] Re: [#7] Printer');
  });
});
