import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStub, type RunningStub } from '../src/stub';

type Received = { headers: Record<string, string | string[] | undefined>; raw: Buffer };
const SECRET = 'test-inbound-secret-123456';

let receiver: Server;
let received: Received[];
let stub: RunningStub;

const startReceiver = async (): Promise<string> => {
  received = [];
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"status":"queued"}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/api/v1/inbound/mail`;
};

const launch = async (chaos: { enabled: boolean; autoreplyRate?: number }): Promise<void> => {
  stub = await startStub({
    smtpPort: 0,
    httpPort: 0,
    inboundUrl: await startReceiver(),
    inboundSecret: SECRET,
    mailDomain: 'helpdesk.test',
    maxMessages: 1000,
    chaos: {
      enabled: chaos.enabled,
      seed: 1,
      failEvery: 10,
      autoreplyRate: chaos.autoreplyRate ?? 0,
    },
  });
};
const api = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${stub.httpPort}${path}`, init);
const smtp = () =>
  nodemailer.createTransport({
    host: '127.0.0.1',
    port: stub.smtpPort,
    secure: false,
    ignoreTLS: true,
    tls: { rejectUnauthorized: false },
  });
const waitFor = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

afterEach(async () => {
  await stub.stop();
  await new Promise<void>((r) => receiver.close(() => r()));
});

describe('SMTP sink and page', () => {
  beforeEach(() => launch({ enabled: false }));

  it('accepts mail over SMTP and shows it with all headers in the JSON API and on the page', async () => {
    await smtp().sendMail({
      from: 'Support <support@helpdesk.test>',
      to: 'ann@customer.test',
      subject: 'Re: [#100123] Printer',
      text: 'We fixed it',
      headers: { 'X-Custom': 'abc', 'Auto-Submitted': 'auto-generated' },
    });
    const list = (await (await api('/api/messages')).json()) as {
      subject: string;
      headers: Record<string, string>;
      text: string;
      to: string[];
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ subject: 'Re: [#100123] Printer', to: ['ann@customer.test'] });
    expect(list[0]?.headers).toMatchObject({
      'x-custom': 'abc',
      'auto-submitted': 'auto-generated',
    });
    expect(list[0]?.headers['message-id']).toMatch(/^<.+>$/);
    const html = await (await api('/')).text();
    expect(html).toContain('Re: [#100123] Printer');
    expect(html).toContain('auto-submitted');
    expect(html).toContain('data-testid="send-inbound"');
  });

  it('escapes everything it renders, so a hostile subject or body cannot run script on the page', async () => {
    await smtp().sendMail({
      from: 'a@x.test',
      to: 'b@x.test',
      subject: '<script>alert(1)</script>',
      text: '<img src=x onerror=alert(2)>',
    });
    const html = await (await api('/')).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)');
  });

  it('filters by recipient and clears the store', async () => {
    await smtp().sendMail({ from: 'a@x.test', to: 'one@x.test', subject: 's1', text: 't' });
    await smtp().sendMail({ from: 'a@x.test', to: 'two@x.test', subject: 's2', text: 't' });
    expect(((await (await api('/api/messages?to=two@')).json()) as unknown[]).length).toBe(1);
    await api('/api/messages', { method: 'DELETE' });
    expect(((await (await api('/api/messages')).json()) as unknown[]).length).toBe(0);
  });
});

describe('inbound sender (button and HTTP)', () => {
  beforeEach(() => launch({ enabled: false }));

  it('posts a signed raw RFC 822 mail to the system with the envelope recipient', async () => {
    const r = await api('/api/inbound', {
      method: 'POST',
      body: JSON.stringify({
        from: 'ann@customer.test',
        to: 'Support@Helpdesk.test',
        subject: 'Help',
        text: 'please',
        inReplyTo: '<abc@helpdesk.test>',
      }),
    });
    expect(r.status).toBe(200);
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got?.headers['content-type']).toBe('message/rfc822');
    expect(got?.headers['x-envelope-to']).toBe('support@helpdesk.test');
    const sig = String(got?.headers['x-inbound-signature']);
    const [, t, mac] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig) ?? [];
    expect(
      createHmac('sha256', SECRET)
        .update(`${t}.`)
        .update(got?.raw ?? Buffer.alloc(0))
        .digest('hex'),
    ).toBe(mac);
    expect(got?.raw.toString()).toContain('In-Reply-To: <abc@helpdesk.test>');
  });

  it('the page button posts a form that reaches the system', async () => {
    const body = new URLSearchParams({
      from: 'ann@customer.test',
      to: 'support@helpdesk.test',
      subject: 'Via button',
      text: 'clicked',
    });
    const r = await api('/ui/inbound', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    await waitFor(() => received.length === 1);
    expect(received[0]?.raw.toString()).toContain('Subject: Via button');
  });

  it('rejects malformed JSON, unknown fields and missing fields with 400', async () => {
    for (const body of [
      '{',
      '{"from":"a@b.test"}',
      JSON.stringify({ from: 'a@b.test', to: 'c@d.test', subject: 's', text: 't', extra: 1 }),
    ]) {
      expect((await api('/api/inbound', { method: 'POST', body })).status).toBe(400);
    }
    expect(received).toHaveLength(0);
  });
});

describe('chaos mode', () => {
  it('delivers each inbound mail twice, concurrently, with identical bytes', async () => {
    await launch({ enabled: true });
    await api('/api/inbound', {
      method: 'POST',
      body: JSON.stringify({
        from: 'a@b.test',
        to: 'support@helpdesk.test',
        subject: 's',
        text: 't',
      }),
    });
    expect(received).toHaveLength(2);
    expect(received[0]?.raw.equals(received[1]?.raw ?? Buffer.alloc(0))).toBe(true);
  });

  it('answers exactly every 10th outbound SMTP transaction with 451 and keeps the rest', async () => {
    await launch({ enabled: true });
    const errors: (number | undefined)[] = [];
    for (let i = 1; i <= 30; i += 1) {
      await smtp()
        .sendMail({ from: 'a@x.test', to: 'b@x.test', subject: `m${i}`, text: 't' })
        .catch((e: { responseCode?: number }) => errors.push(e.responseCode));
    }
    expect(errors).toEqual([451, 451, 451]);
    const stats = (await (await api('/api/stats')).json()) as {
      transactions: number;
      failed: number;
      delivered: number;
    };
    expect(stats).toMatchObject({ transactions: 30, failed: 3, delivered: 27, stored: 27 });
    const subjects = (
      (await (await api('/api/messages?limit=100')).json()) as { subject: string }[]
    ).map((m) => m.subject);
    expect(subjects).not.toContain('m10');
    expect(subjects).not.toContain('m20');
    expect(subjects).toContain('m9');
  });

  it('sometimes answers a sent mail with an autoreply or a bounce that references it', async () => {
    await launch({ enabled: true, autoreplyRate: 1 });
    for (let i = 0; i < 4; i += 1)
      await smtp().sendMail({
        from: 'Support <support@helpdesk.test>',
        to: 'ann@customer.test',
        subject: `Sent ${i}`,
        text: 't',
        messageId: `<orig-${i}@helpdesk.test>`,
      });
    await waitFor(() => received.length >= 8); // each response is also duplicated by chaos
    const texts = received.map((r) => r.raw.toString());
    const auto = texts.filter((t) => /^Auto-Submitted: auto-replied/im.test(t));
    const bounces = texts.filter((t) => /^Return-Path: <>/im.test(t));
    expect(auto.length).toBeGreaterThan(0);
    expect(bounces.length).toBeGreaterThan(0);
    for (const t of [...auto, ...bounces])
      expect(t).toMatch(/^In-Reply-To: <orig-\d@helpdesk\.test>/im);
    expect(bounces.every((t) => /^From: MAILER-DAEMON@/im.test(t))).toBe(true);
    expect(auto.every((t) => /^To: support@helpdesk\.test/im.test(t))).toBe(true);
  });

  it('can be switched at runtime and reports its state', async () => {
    await launch({ enabled: false });
    expect(((await (await api('/api/chaos')).json()) as { enabled: boolean }).enabled).toBe(false);
    await api('/api/chaos', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(((await (await api('/api/chaos')).json()) as { enabled: boolean }).enabled).toBe(true);
    expect((await api('/api/chaos', { method: 'PUT', body: '{"enabled":"yes"}' })).status).toBe(
      400,
    );
    expect(await (await api('/')).text()).toContain('chaos ON');
  });
});

describe('abusive SMTP clients (review F9)', () => {
  beforeEach(() => launch({ enabled: false }));

  it('survives connections that are reset in the middle of a transaction and keeps the stored mail', async () => {
    await smtp().sendMail({
      from: 'a@x.test',
      to: 'support@helpdesk.test',
      subject: 'KEPT',
      text: 'kept',
    });
    for (let i = 0; i < 5; i += 1) {
      const sock = connect(stub.smtpPort, '127.0.0.1');
      await new Promise<void>((r) => sock.once('data', () => r()));
      sock.write(
        'EHLO x\r\nMAIL FROM:<a@x.test>\r\nRCPT TO:<support@helpdesk.test>\r\nDATA\r\nSubject: half\r\n\r\nhalf a mes',
      );
      await new Promise((r) => setTimeout(r, 30));
      sock.resetAndDestroy();
    }
    await new Promise((r) => setTimeout(r, 200));
    const list = (await (await api('/api/messages')).json()) as
      { messages?: unknown[] } | unknown[];
    const count = Array.isArray(list) ? list.length : (list.messages?.length ?? 0);
    expect(count).toBe(1);
  });
});

describe('repeated Message-ID (review F6)', () => {
  beforeEach(() => launch({ enabled: false }));

  it('acknowledges but does not store a second delivery of the same Message-ID to the same recipient', async () => {
    const mail = {
      from: 'helpdesk@helpdesk.test',
      to: 'cust@customer.test',
      subject: 'Answer',
      text: 'once',
      messageId: '<same-id@helpdesk.test>',
    };
    await smtp().sendMail(mail);
    await smtp().sendMail(mail);
    await smtp().sendMail({ ...mail, to: 'other@customer.test' });
    const list = (await (await api('/api/messages')).json()) as
      { messages?: unknown[] } | unknown[];
    const count = Array.isArray(list) ? list.length : (list.messages?.length ?? 0);
    expect(count).toBe(2);
    expect(stub.stats.duplicates).toBe(1);
  });
});
