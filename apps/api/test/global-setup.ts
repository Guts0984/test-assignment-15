import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

/** Recreates the api test database and applies every migration once per run. */
export async function setup(): Promise<void> {
  const envFile = resolve(__dirname, '../../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const base = process.env.TEST_DATABASE_URL;
  if (base === undefined)
    throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env)');
  const name = 'helpdesk_test_api';
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.$disconnect();
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  const coreDir = dirname(require.resolve('@helpdesk/core/package.json'));
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js', { paths: [coreDir] }), 'migrate', 'deploy'],
    {
      cwd: coreDir,
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
    },
  );
}
