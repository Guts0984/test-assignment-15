import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { createDb } from '@helpdesk/core';
import { systemClock } from '@helpdesk/shared';
import { env, inheritedEnv } from '../config/env';
import { hashPassword } from '../infra/password';
import { runSeed } from '../seed/seed-run';

const say = (line: string): void => {
  process.stdout.write(`[migrate-and-seed] ${line}\n`);
};

/** Applies pending Prisma migrations using the CLI bundled with @helpdesk/core. */
export const migrate = (databaseUrl: string): void => {
  const corePackage = require.resolve('@helpdesk/core/package.json');
  const coreDir = dirname(corePackage);
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [coreDir] });
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: coreDir,
    env: { ...inheritedEnv(), DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
};

const main = async (): Promise<void> => {
  say('applying migrations');
  migrate(env.DATABASE_URL);
  const db = createDb(env.DATABASE_URL);
  try {
    const passwordHash = await hashPassword(env.SEED_STAFF_PASSWORD, {
      memoryKiB: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
    });
    say(`seeding profile "${env.SEED_PROFILE}"${env.SEED_RESET ? ' (reset)' : ''}`);
    const outcome = await runSeed(db, {
      profile: env.SEED_PROFILE,
      randomSeed: env.SEED_RANDOM_SEED,
      reset: env.SEED_RESET,
      passwordHash,
      clock: systemClock,
      warningRatio: env.SLA_WARNING_RATIO,
      log: say,
    });
    say(
      outcome.status === 'seeded'
        ? `done: ${JSON.stringify(outcome.liveSet)} live tickets`
        : `skipped (${outcome.reason})`,
    );
  } finally {
    await db.$disconnect();
  }
};

main().catch((e: unknown) => {
  process.stderr.write(
    `[migrate-and-seed] failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
