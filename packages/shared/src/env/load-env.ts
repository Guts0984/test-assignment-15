import { z } from 'zod';
import { err, ok, type Result } from '../result/result';

/** Strict boolean for env strings. Anything but "true"/"false" is a configuration error. */
export const envBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export type EnvLoadError = { readonly message: string };

/**
 * Parses an env source with a zod schema and returns a readable error.
 * The caller (an app's `config/env.ts`) decides what to do with a failure.
 */
export const loadEnv = <S extends z.ZodTypeAny>(
  schema: S,
  source: Record<string, string | undefined>,
): Result<Readonly<z.output<S>>, EnvLoadError> => {
  const parsed = schema.safeParse(source);
  if (parsed.success) return ok(Object.freeze({ ...parsed.data }));
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  return err({ message: `Invalid environment configuration:\n${lines.join('\n')}` });
};
