import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@helpdesk/shared': resolve(__dirname, '../shared/src/index.ts') } },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.int.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
