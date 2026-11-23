import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const base = process.env.TEST_DATABASE_URL;
if (base === undefined) throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env)');
const dbUrl = new URL(base);
dbUrl.pathname = '/helpdesk_test_api';
process.env.DATABASE_URL = dbUrl.toString();
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
process.env.NODE_ENV = 'test';
process.env.TEST_CLOCK_ENABLED = 'true';
process.env.TEST_CONTROL_TOKEN = process.env.TEST_CONTROL_TOKEN ?? 'dev-only-test-control-token';
process.env.ARGON2_MEMORY_KIB = '4096';
process.env.ARGON2_TIME_COST = '1';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:8080';
