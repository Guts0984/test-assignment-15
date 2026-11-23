import { envBool, loadEnv } from '@helpdesk/shared';
import { z } from 'zod';

const intStr = (def: number) => z.coerce.number().int().default(def);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default('redis://redis:6379'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
    MAIL_DOMAIN: z.string().min(3).default('helpdesk.test'),
    SMTP_HOST: z.string().default('mail-stub'),
    SMTP_PORT: intStr(1025),
    SMTP_FROM_NAME: z.string().default('Helpdesk Support'),
    MAGIC_LINK_TTL_DAYS: intStr(30),
    SURVEY_TTL_DAYS: intStr(7),
    AUTO_CLOSE_AFTER_HOURS: intStr(72),
    UNDO_SEND_SECONDS: intStr(10),
    SLA_WARNING_RATIO: z.coerce.number().min(0.01).max(0.99).default(0.8),
    WORKER_CONCURRENCY: intStr(10),
    RECONCILE_INTERVAL_MS: intStr(5000),
    RECONCILE_HORIZON_MS: intStr(600_000),
    JOB_MAX_ATTEMPTS: intStr(8),
    JOB_BACKOFF_BASE_MS: intStr(1000),
    JOB_BACKOFF_MAX_MS: intStr(300_000),
    OUTBOUND_LEASE_MS: intStr(30_000),
    TEST_CLOCK_ENABLED: envBool.default('false'),
  })
  .strip();

export type Env = Readonly<z.output<typeof envSchema>>;

const loaded = loadEnv(envSchema, process.env);
if (!loaded.ok) {
  process.stderr.write(`${loaded.error.message}\n`);
  process.exit(1);
}

export const env: Env = loaded.value;
