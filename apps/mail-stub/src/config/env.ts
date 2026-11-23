import { envBool, loadEnv } from '@helpdesk/shared';
import { z } from 'zod';

const intStr = (def: number) => z.coerce.number().int().default(def);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MAIL_DOMAIN: z.string().min(3).default('helpdesk.test'),
  MAIL_STUB_SMTP_PORT: intStr(1025),
  MAIL_STUB_HTTP_PORT: intStr(8025),
  MAIL_STUB_INBOUND_URL: z.string().url().default('http://nginx/api/v1/inbound/mail'),
  MAIL_STUB_MAX_MESSAGES: intStr(50_000),
  INBOUND_WEBHOOK_SECRET: z.string().min(16),
  MAIL_CHAOS: envBool.default('false'),
  MAIL_CHAOS_SMTP_FAIL_EVERY: intStr(10),
  MAIL_CHAOS_AUTOREPLY_RATE: z.coerce.number().min(0).max(1).default(0.1),
  MAIL_CHAOS_SEED: intStr(1),
});

export type Env = Readonly<z.output<typeof envSchema>>;

const loaded = loadEnv(envSchema, process.env);
if (!loaded.ok) {
  process.stderr.write(`${loaded.error.message}\n`);
  process.exit(1);
}

export const env: Env = loaded.value;
