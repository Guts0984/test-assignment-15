import mailparser from 'mailparser';
import { describe, expect, it } from 'vitest';
import { composeRaw } from './compose';

describe('composeRaw', () => {
  it('builds a parseable message with threading headers', async () => {
    const { raw, messageId } = composeRaw(
      {
        from: 'a@x.test',
        to: 'support@h.test',
        subject: 'Hi',
        text: 'body',
        inReplyTo: 'orig@h.test',
        references: ['orig@h.test'],
      },
      'stub.test',
    );
    const p = await mailparser.simpleParser(raw);
    expect([p.subject, p.text?.trim(), p.inReplyTo, p.messageId]).toEqual([
      'Hi',
      'body',
      '<orig@h.test>',
      `<${messageId}>`,
    ]);
  });

  it('cannot be used for header injection through any field', async () => {
    const { raw } = composeRaw(
      {
        from: 'a@x.test\r\nBcc: evil@x.test',
        to: 'support@h.test',
        subject: 'Hi\r\nX-Evil: 1',
        text: 'b',
        headers: { 'X-Ok': 'v\r\nX-Evil2: 2', 'Bad Name\r\nX-Evil3': 'x' },
      },
      'stub.test',
    );
    const head = raw.toString().split('\r\n\r\n')[0] ?? '';
    expect(head).not.toMatch(/^Bcc:/im);
    expect(head).not.toMatch(/^X-Evil/im);
  });

  it('encodes attachments as base64 parts', async () => {
    const { raw } = composeRaw(
      {
        from: 'a@x.test',
        to: 'b@x.test',
        subject: 's',
        text: 't',
        attachments: [
          { filename: 'a.txt', contentBase64: Buffer.from('hello').toString('base64') },
        ],
      },
      'stub.test',
    );
    const p = await mailparser.simpleParser(raw);
    expect(p.attachments[0]?.content.toString()).toBe('hello');
  });
});
