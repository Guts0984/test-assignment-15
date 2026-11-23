import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createDb, type Db } from '@helpdesk/core';
import { PrismaClient } from '@prisma/client';

export type IsolatedDb = {
  readonly db: Db;
  readonly url: string;
  readonly drop: () => Promise<void>;
};

/** A throw-away migrated database, for suites that need an empty one (seed, reset, FLUSHALL-style tests). */
export const createIsolatedDb = async (suffix: string): Promise<IsolatedDb> => {
  const base = process.env.TEST_DATABASE_URL;
  if (base === undefined)
    throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env)');
  const name = `helpdesk_test_${suffix}`.replace(/[^a-z0-9_]/g, '_');
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
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
  const db = createDb(url.toString());
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.$disconnect();
    },
  };
};

export const repoRoot = resolve(__dirname, '../../../..');
