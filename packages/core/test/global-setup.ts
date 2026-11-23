import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const repoRoot = resolve(__dirname, '../../..');

/** Recreates the test database and applies every migration once for the whole run. */
export async function setup(): Promise<void> {
  const envFile = resolve(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined)
    throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env)');
  const dbName = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
    throw new Error(`Refusing to recreate database "${dbName}": the name must contain "test"`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.$disconnect();
  }
  execFileSync(resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
