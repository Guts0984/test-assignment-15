import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Chaos } from '../chaos/chaos';
import { composeRaw } from '../inbound/compose';
import type { Deliverer } from '../inbound/deliver';
import type { SmtpStats } from '../smtp/smtp-server';
import type { Store } from '../store/store';
import { renderPage } from './html';

const inboundSchema = z
  .object({
    from: z.string().min(3).max(300),
    to: z.string().min(3).max(300),
    subject: z.string().max(500),
    text: z.string().max(200_000),
    messageId: z.string().max(300).optional(),
    inReplyTo: z.string().max(300).optional(),
    references: z.array(z.string().max(300)).max(50).optional(),
    headers: z.record(z.string().max(1000)).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().max(255),
          contentBase64: z.string().max(40_000_000),
          contentType: z.string().max(200).optional(),
        }),
      )
      .max(20)
      .optional(),
  })
  .strict();

export type HttpDeps = {
  readonly store: Store;
  readonly chaos: Chaos;
  readonly deliverer: Deliverer;
  readonly stats: SmtpStats;
  readonly mailDomain: string;
};

const readBody = (req: IncomingMessage, max: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Sends one inbound mail the way a mail server would: composed, signed, posted (twice in chaos mode). */
export const sendInbound = async (d: HttpDeps, input: z.infer<typeof inboundSchema>) => {
  const { raw, messageId } = composeRaw(input, d.mailDomain);
  const results = await d.deliverer.deliver(
    input.to.trim().toLowerCase(),
    raw,
    d.chaos.shouldDuplicateInbound(),
  );
  return { messageId, deliveries: results };
};

export const createHttpServer = (d: HttpDeps): Server =>
  createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      try {
        if (req.method === 'GET' && url.pathname === '/health')
          return json(res, 200, { status: 'ok' });
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return void res.end(
            renderPage(d.store.list({ limit: 100 }), d.chaos.settings().enabled, {
              mailDomain: d.mailDomain,
            }),
          );
        }
        if (req.method === 'GET' && url.pathname === '/api/messages') {
          const limit = Number(url.searchParams.get('limit') ?? 200);
          return json(
            res,
            200,
            d.store.list({
              ...(url.searchParams.has('to') ? { to: url.searchParams.get('to') ?? '' } : {}),
              ...(url.searchParams.has('messageId')
                ? { messageId: url.searchParams.get('messageId') ?? '' }
                : {}),
              ...(url.searchParams.has('subject')
                ? { subject: url.searchParams.get('subject') ?? '' }
                : {}),
              limit: Number.isFinite(limit) ? limit : 200,
            }),
          );
        }
        if (req.method === 'GET' && url.pathname === '/api/stats')
          return json(res, 200, { ...d.stats, stored: d.store.count() });
        if (req.method === 'DELETE' && url.pathname === '/api/messages') {
          d.store.clear();
          d.stats.transactions = 0;
          d.stats.failed = 0;
          d.stats.delivered = 0;
          d.chaos.reset();
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/chaos') {
          if (req.method === 'PUT') {
            const parsed = z
              .object({ enabled: z.boolean() })
              .strict()
              .safeParse(JSON.parse((await readBody(req, 1000)).toString() || '{}'));
            if (!parsed.success)
              return json(res, 400, { error: 'expected { "enabled": boolean }' });
            d.chaos.setEnabled(parsed.data.enabled);
          }
          return json(res, 200, d.chaos.settings());
        }
        if (req.method === 'POST' && url.pathname === '/api/inbound') {
          const body = await readBody(req, 50_000_000);
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(body.toString('utf8'));
          } catch {
            return json(res, 400, { error: 'body must be JSON' });
          }
          const parsed = inboundSchema.safeParse(parsedJson);
          if (!parsed.success)
            return json(res, 400, { error: 'invalid input', issues: parsed.error.issues });
          return json(res, 200, await sendInbound(d, parsed.data));
        }
        if (req.method === 'POST' && url.pathname === '/ui/inbound') {
          const fields = new URLSearchParams((await readBody(req, 1_000_000)).toString('utf8'));
          const parsed = inboundSchema.safeParse({
            from: fields.get('from') ?? '',
            to: fields.get('to') ?? '',
            subject: fields.get('subject') ?? '',
            text: fields.get('text') ?? '',
            ...(fields.get('inReplyTo') ? { inReplyTo: fields.get('inReplyTo') ?? '' } : {}),
          });
          if (!parsed.success) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            return void res.end('Invalid input');
          }
          await sendInbound(d, parsed.data);
          res.writeHead(303, { location: '/' });
          return void res.end();
        }
        json(res, 404, { error: 'not found' });
      } catch (e) {
        json(res, e instanceof Error && e.message === 'too large' ? 413 : 500, {
          error: 'request failed',
        });
      }
    })();
  });
