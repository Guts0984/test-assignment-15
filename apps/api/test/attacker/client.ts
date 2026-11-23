import { send, type Reply, type RequestOptions } from './http';

export type Client = {
  readonly baseUrl: string;
  readonly request: (o: RequestOptions) => Promise<Reply>;
  readonly get: (path: string, o?: Partial<RequestOptions>) => Promise<Reply>;
  readonly post: (
    path: string,
    body?: RequestOptions['body'],
    o?: Partial<RequestOptions>,
  ) => Promise<Reply>;
  readonly put: (
    path: string,
    body?: RequestOptions['body'],
    o?: Partial<RequestOptions>,
  ) => Promise<Reply>;
  readonly patch: (
    path: string,
    body?: RequestOptions['body'],
    o?: Partial<RequestOptions>,
  ) => Promise<Reply>;
  readonly del: (path: string, o?: Partial<RequestOptions>) => Promise<Reply>;
};

export type ClientAuth =
  | { readonly bearer: string }
  | { readonly ticketToken: string }
  | { readonly cookie: string }
  | undefined;

/** A client with its own source IP and credentials, like one real user (or attacker). */
export const client = (o: { baseUrl: string; sourceIp?: string; auth?: ClientAuth }): Client => {
  const authHeaders: Record<string, string> =
    o.auth === undefined
      ? {}
      : 'bearer' in o.auth
        ? { authorization: `Bearer ${o.auth.bearer}` }
        : 'ticketToken' in o.auth
          ? { 'x-ticket-token': o.auth.ticketToken }
          : { cookie: o.auth.cookie };
  const request = (r: RequestOptions): Promise<Reply> =>
    send(o.baseUrl, {
      ...r,
      headers: { ...authHeaders, ...(r.headers ?? {}) },
      sourceIp: r.sourceIp ?? o.sourceIp,
    });
  const withBody =
    (method: string) =>
    (path: string, body?: RequestOptions['body'], x: Partial<RequestOptions> = {}) =>
      request({ ...x, method, path, body });
  return {
    baseUrl: o.baseUrl,
    request,
    get: (path, x = {}) => request({ ...x, method: 'GET', path }),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    del: (path, x = {}) => request({ ...x, method: 'DELETE', path }),
  };
};
