import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env';
import { buildOpenApiDocument, createApiApp } from '../app.factory';

/** Writes apps/api/openapi.json for the default profile (no test-only routes). Needs no database connection. */
const main = async (): Promise<void> => {
  const app = await createApiApp(Object.freeze({ ...env, TEST_CLOCK_ENABLED: false }));
  await app.init();
  const doc = buildOpenApiDocument(app);
  writeFileSync(resolve(__dirname, '../../openapi.json'), `${JSON.stringify(doc, null, 2)}\n`);
  await app.close();
};

main().catch((e: unknown) => {
  process.stderr.write(
    `openapi emit failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
