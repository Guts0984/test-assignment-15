import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@helpdesk/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@helpdesk/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.int.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    // Redis is shared and some suites wipe it, so files run one after another.
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
