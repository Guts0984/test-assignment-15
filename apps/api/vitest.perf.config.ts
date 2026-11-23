import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Performance budgets on the FULL seed (default compose profile): search < 300 ms, agent queue < 200 ms, 90-day report < 1 s.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: { '@helpdesk/shared': resolve(__dirname, '../../packages/shared/src/index.ts'), '@helpdesk/core': resolve(__dirname, '../../packages/core/src/index.ts') } },
  test: { include: ['test/perf/**/*.perf.spec.ts'], setupFiles: ['test/stack/setup-stack-env.ts'], fileParallelism: false, testTimeout: 300_000, hookTimeout: 300_000 },
});
