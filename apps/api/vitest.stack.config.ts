import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Suites that talk to the REAL running compose stack (nginx, two api copies, three workers, mail stub).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@helpdesk/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@helpdesk/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['test/stack/**/*.stack.spec.ts'],
    setupFiles: ['test/stack/setup-stack-env.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
