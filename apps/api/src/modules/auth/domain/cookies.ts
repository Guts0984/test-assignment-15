export const REFRESH_COOKIE = 'hd_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Reads one cookie from a Cookie header without a cookie library. */
export const readCookie = (header: string | undefined, name: string): string | null => {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
};

export const refreshCookie = (value: string, maxAgeSeconds: number, secure: boolean): string =>
  [
    `${REFRESH_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');

export const clearRefreshCookie = (secure: boolean): string => refreshCookie('', 0, secure);
