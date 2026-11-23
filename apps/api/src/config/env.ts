import { envBool, loadEnv } from '@helpdesk/shared';
import { z } from 'zod';

const intStr = (def: number) => z.coerce.number().int().default(def);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_PORT: intStr(3000),
    API_INSTANCE_ID: z.string().min(1).default('api'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default('redis://redis:6379'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
    CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:8080'),
    TRUSTED_PROXY_CIDRS: z.string().default('172.16.0.0/12,10.0.0.0/8'),
    JSON_BODY_LIMIT_BYTES: intStr(1_048_576),
    MAX_ATTACHMENTS_BYTES: intStr(10_485_760),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: intStr(900),
    REFRESH_TOKEN_TTL_DAYS: intStr(7),
    ARGON2_MEMORY_KIB: intStr(19_456),
    ARGON2_TIME_COST: intStr(2),
    MAGIC_LINK_TTL_DAYS: intStr(30),
    SURVEY_TTL_DAYS: intStr(7),
    AUTO_CLOSE_AFTER_HOURS: intStr(72),
    UNDO_SEND_SECONDS: intStr(10),
    SLA_WARNING_RATIO: z.coerce.number().min(0.01).max(0.99).default(0.8),
    SHIFT_OFF_REPLY_WINDOW_MINUTES: intStr(60),
    INBOUND_WEBHOOK_SECRET: z.string().min(16),
    INBOUND_SIGNATURE_TOLERANCE_SECONDS: intStr(300),
    MAIL_DOMAIN: z.string().min(3).default('helpdesk.test'),
    PRESENCE_TTL_SECONDS: intStr(30),
    PRESENCE_HEARTBEAT_SECONDS: intStr(10),
    SOCKET_PING_INTERVAL_MS: intStr(10_000),
    SOCKET_PING_TIMEOUT_MS: intStr(10_000),
    SOCKET_EVENT_BUDGET_PER_SECOND: intStr(20),
    TEST_CLOCK_ENABLED: envBool.default('false'),
    TEST_CONTROL_TOKEN: z.string().optional(),
    SEED_PROFILE: z.enum(['full', 'small', 'none']).default('full'),
    SEED_RANDOM_SEED: intStr(42),
    SEED_RESET: envBool.default('false'),
    SEED_STAFF_PASSWORD: z.string().min(8),
  })
  .refine((v) => !v.TEST_CLOCK_ENABLED || (v.TEST_CONTROL_TOKEN?.length ?? 0) >= 16, {
    path: ['TEST_CONTROL_TOKEN'],
    message: 'required (at least 16 characters) when TEST_CLOCK_ENABLED=true',
  });

export type Env = Readonly<z.output<typeof envSchema>>;

const loaded = loadEnv(envSchema, process.env);
if (!loaded.ok) {
  process.stderr.write(`${loaded.error.message}\n`);
  process.exit(1);
}

export const env: Env = loaded.value;
