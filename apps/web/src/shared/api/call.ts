import { isApiError } from '../lib/api-errors';

export type ApiCallError = Error & {
  readonly status: number;
  readonly body: unknown;
  readonly code: string;
};

export const apiCallError = (status: number, body: unknown): ApiCallError =>
  Object.assign(new Error(isApiError(body) ? body.error.message : `Request failed (${status})`), {
    status,
    body,
    code: isApiError(body) ? body.error.code : 'UNKNOWN',
  });

export const isApiCallError = (e: unknown): e is ApiCallError =>
  e instanceof Error && 'status' in e && 'body' in e;

/** Unwraps an openapi-fetch result: data on success, a typed error otherwise (so TanStack Query sees failures). */
export const unwrap = async <T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> => {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) throw apiCallError(r.response.status, r.error);
  return r.data as T;
};
