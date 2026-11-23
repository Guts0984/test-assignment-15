import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_HTTP_STATUS, errorResponseSchema } from './error-codes';

describe('error codes', () => {
  it('maps every code to a 4xx/5xx status', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_HTTP_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
  it('only INTERNAL_ERROR maps to 500', () => {
    expect(ERROR_CODES.filter((c) => ERROR_HTTP_STATUS[c] === 500)).toEqual(['INTERNAL_ERROR']);
  });
  it('validates the shared error body', () => {
    expect(
      errorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success,
    ).toBe(true);
    expect(
      errorResponseSchema.safeParse({ error: { code: 'WHATEVER', message: 'x' } }).success,
    ).toBe(false);
  });
});
