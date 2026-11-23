import swc from 'unplugin-swc';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const config = defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    // Tests run against the workspace sources, so no build step is needed first.
    alias: {
      '@helpdesk/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@helpdesk/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.{int,adv}.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

export default config;
