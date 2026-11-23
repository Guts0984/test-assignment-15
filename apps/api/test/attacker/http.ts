import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';

export type Reply = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly json: unknown;
  readonly ms: number;
};

export type RequestOptions = {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer | object;
  /** Bind the outgoing connection to this local address (127.0.0.N) to act as a distinct client. */
  readonly sourceIp?: string;
  readonly timeoutMs?: number;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** One real HTTP request over a real socket. Objects are JSON-encoded; strings and buffers are sent as given. */
export const send = (baseUrl: string, o: RequestOptions): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const url = new URL(o.path, baseUrl);
    const started = performance.now();
    const isObject = o.body !== undefined && typeof o.body === 'object' && !Buffer.isBuffer(o.body);
    const payload =
      o.body === undefined
        ? undefined
        : isObject
          ? JSON.stringify(o.body)
          : (o.body as string | Buffer);
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (payload !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(payload));
      if (isObject && headers['content-type'] === undefined)
        headers['content-type'] = 'application/json';
    }
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: o.method ?? 'GET',
        headers,
        ...(o.sourceIp === undefined ? {} : { localAddress: o.sourceIp }),
        timeout: o.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: parseJson(text),
            ms: performance.now() - started,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

/** Writes raw bytes to the server socket (malformed requests, smuggling attempts) and returns what came back. */
export const raw = (
  host: string,
  port: number,
  bytes: string | Buffer,
  waitMs = 1500,
): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host, port }, () => socket.write(bytes));
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('latin1'));
    }, waitMs).unref();
  });

/** Fires `n` calls at the same moment. */
export const burst = <T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

export const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t };
};
