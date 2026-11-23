import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envBool, loadEnv } from './load-env';

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  SECRET: z.string().min(8),
  FLAG: envBool.default('false'),
});

describe('loadEnv', () => {
  it('applies defaults to non-sensitive values and freezes the result', () => {
    const r = loadEnv(schema, { SECRET: 'abcdefgh' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ PORT: 3000, SECRET: 'abcdefgh', FLAG: false });
    expect(Object.isFrozen(r.value)).toBe(true);
  });

  it('reports every missing or invalid variable by name', () => {
    const r = loadEnv(schema, { FLAG: 'yes', PORT: 'abc' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('SECRET');
    expect(r.error.message).toContain('FLAG');
    expect(r.error.message).toContain('PORT');
  });

  it('does not echo secret values in the error', () => {
    const r = loadEnv(schema, { SECRET: 'short' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain('short');
  });
});
