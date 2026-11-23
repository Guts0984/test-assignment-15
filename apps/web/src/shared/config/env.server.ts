import { loadEnv } from '@helpdesk/shared';
import { z } from 'zod';

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  WEB_PORT: z.coerce.number().int().default(3000),
  WEB_INTERNAL_API_URL: z.string().url().default('http://nginx'),
});

export type ServerEnv = Readonly<z.output<typeof serverEnvSchema>>;

const loaded = loadEnv(serverEnvSchema, process.env);
if (!loaded.ok) {
  process.stderr.write(`${loaded.error.message}\n`);
  process.exit(1);
}

export const serverEnv: ServerEnv = loaded.value;
