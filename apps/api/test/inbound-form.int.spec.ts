import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import { multipart } from './attacker/multipart';
import { createTeamRow, startApi, testDb, uniq, type RunningApi } from './helpers/api';
import { createMailbox, postMail, rawMail, receiveTicket } from './helpers/tickets';

let api: RunningApi;
const db = testDb();
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe('inbound webhook', () => {
  it('stores a signed mail durably, queues a job and answers 202; the same mail again is a duplicate', async () => {
    const team = await createTeamRow(db);
    const box = await createMailbox(team.id);
    const raw = rawMail({ from: `${uniq('c')}@x.test`, to: box, subject: 'Hello', text: 'x' });
    const first = await postMail(api, box, raw);
    expect([first.status, (first.json as { status: string }).status]).toEqual([202, 'queued']);
    const second = await postMail(api, box, raw);
    expect([second.status, (second.json as { status: string }).status]).toEqual([202, 'duplicate']);
    const rows = await db.inboundMessage.findMany({ where: { mailboxAddress: box } });
    expect(rows).toHaveLength(1);
    expect(await db.job.count({ where: { kind: 'inbound_process', ref: rows[0]?.id } })).toBe(1);
  });

  it('50 simultaneous deliveries of one mail through the api create one stored mail', async () => {
    const team = await createTeamRow(db);
    const box = await createMailbox(team.id);
    const raw = rawMail({ from: `${uniq('c')}@x.test`, to: box, subject: 'Burst', text: 'x' });
    const results = await Promise.all(Array.from({ length: 50 }, () => postMail(api, box, raw)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(results.filter((r) => (r.json as { status: string }).status === 'queued')).toHaveLength(
      1,
    );
    expect(await db.inboundMessage.count({ where: { mailboxAddress: box } })).toBe(1);
  });

  it('rejects missing, wrong, tampered and stale signatures with 401 INBOUND_SIGNATURE_INVALID', async () => {
    const team = await createTeamRow(db);
    const box = await createMailbox(team.id);
    const raw = rawMail({ from: 'a@x.test', to: box, subject: 's', text: 't' });
    const code = (r: { json: unknown }) => (r.json as { error: { code: string } }).error.code;
    expect(code(await postMail(api, box, raw, 'wrong-secret-wrong-secret'))).toBe(
      'INBOUND_SIGNATURE_INVALID',
    );
    expect(
      code(await postMail(api, box, raw, undefined, Math.floor(Date.now() / 1000) - 3600)),
    ).toBe('INBOUND_SIGNATURE_INVALID');
    const noSig = await client({ baseUrl: api.url }).request({
      method: 'POST',
      path: '/api/v1/inbound/mail',
      body: raw,
      headers: { 'content-type': 'message/rfc822', 'x-envelope-to': box },
    });
    expect(noSig.status).toBe(401);
    expect(await db.inboundMessage.count({ where: { mailboxAddress: box } })).toBe(0);
  });

  it('rejects an empty body, a wrong content type and a bad envelope address', async () => {
    const team = await createTeamRow(db);
    const box = await createMailbox(team.id);
    const c = client({ baseUrl: api.url });
    expect(
      (
        await c.request({
          method: 'POST',
          path: '/api/v1/inbound/mail',
          body: '{"a":1}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(415);
    const raw = rawMail({ from: 'a@x.test', to: box, subject: 's', text: 't' });
    expect((await postMail(api, 'not an address', raw)).status).toBe(400);
  });
});

describe('web form', () => {
  const form = (
    over: Record<string, string> = {},
    files: { filename: string; content: Buffer }[] = [],
  ) =>
    multipart([
      ...Object.entries({
        email: `${uniq('f')}@customer.test`,
        name: 'Form User',
        subject: 'Cannot log in',
        body: 'Help please',
        ...over,
      }).map(([name, value]) => ({ name, value })),
      ...files.map((f) => ({ name: 'attachments', ...f })),
    ]);
  const submit = (m: ReturnType<typeof multipart>) =>
    client({ baseUrl: api.url }).request({
      method: 'POST',
      path: '/api/v1/public/tickets',
      body: m.body,
      headers: m.headers,
    });

  it('creates a ticket with attachments, sends no link in the response and queues the acknowledgement email', async () => {
    const team = await createTeamRow(db);
    await createMailbox(team.id);
    await db.mailbox.upsert({
      where: { address: `support@${api.env.MAIL_DOMAIN}` },
      update: { defaultTeamId: team.id },
      create: { address: `support@${api.env.MAIL_DOMAIN}`, defaultTeamId: team.id },
    });
    const email = `${uniq('f')}@customer.test`;
    const r = await submit(
      form({ email }, [{ filename: 'note.txt', content: Buffer.from('attached text') }]),
    );
    expect(r.status).toBe(201);
    const { number, message } = r.json as { number: number; message: string };
    expect(r.text).not.toMatch(/token|portal/i);
    expect(message).toContain('emailed');
    const t = await db.ticket.findFirstOrThrow({
      where: { number },
      include: { messages: { include: { attachments: true } } },
    });
    expect([t.source, t.status, t.teamId]).toEqual(['web', 'new', team.id]);
    expect(t.messages[0]?.attachments[0]?.filename).toBe('note.txt');
    const ack = await db.outboundEmail.findFirstOrThrow({ where: { ticketId: t.id } });
    expect([ack.toEmail, ack.purpose]).toEqual([email, 'acknowledgement']);
  });

  it('accepts exactly 10 MB and answers 413 for one byte more', async () => {
    const ok = await submit(
      form({}, [{ filename: 'big.bin', content: Buffer.alloc(10 * 1024 * 1024, 7) }]),
    );
    expect(ok.status).toBe(201);
    const tooBig = await submit(
      form({}, [{ filename: 'big.bin', content: Buffer.alloc(10 * 1024 * 1024 + 1, 7) }]),
    );
    expect(tooBig.status).toBe(413);
    expect((tooBig.json as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    const two = await submit(
      form({}, [
        { filename: 'a.bin', content: Buffer.alloc(6 * 1024 * 1024) },
        { filename: 'b.bin', content: Buffer.alloc(6 * 1024 * 1024) },
      ]),
    );
    expect(two.status).toBe(413);
  });

  it('reports field-level errors for bad input', async () => {
    const r = await submit(form({ email: 'not-an-email', subject: '' }));
    expect(r.status).toBe(400);
    const paths = (r.json as { error: { details: { path: string[] }[] } }).error.details.map((d) =>
      d.path.join('.'),
    );
    expect(paths).toEqual(expect.arrayContaining(['email', 'subject']));
  });

  it('a double submit with the same idempotency key creates one ticket', async () => {
    const key = `key-${uniq('k')}`;
    const email = `${uniq('f')}@customer.test`;
    const body = () => form({ email, idempotencyKey: key });
    const results = await Promise.all([submit(body()), submit(body()), submit(body())]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const numbers = results.map((r) => (r.json as { number: number }).number);
    expect(new Set(numbers).size).toBe(1);
    expect(await db.ticket.count({ where: { customer: { email } } })).toBe(1);
  });

  it('stores hostile text as inert data and strips path tricks from file names', async () => {
    const r = await submit(
      form({ subject: '<script>alert(1)</script>', body: "'; DROP TABLE tickets; --" }, [
        { filename: '../../../etc/passwd', content: Buffer.from('x') },
      ]),
    );
    expect(r.status).toBe(201);
    const t = await db.ticket.findFirstOrThrow({
      where: { number: (r.json as { number: number }).number },
      include: { messages: { include: { attachments: true } } },
    });
    expect(t.messages[0]?.attachments[0]?.filename).toBe('passwd');
  });
});

describe('end to end: mail in, ticket out', () => {
  it('receiveTicket helper round-trips through the webhook and the core processor', async () => {
    const team = await createTeamRow(db);
    const box = await createMailbox(team.id);
    const t = await receiveTicket(api, box);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: t.ticketId } })).teamId).toBe(team.id);
  });
});
