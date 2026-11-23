import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@helpdesk/shared': resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  test: { include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'], testTimeout: 30_000 },
});
