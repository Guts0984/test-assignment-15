import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same `@/` alias as tsconfig, so model files can import other slices through their public API.
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: { include: ['src/**/*.spec.ts', 'lint/**/*.spec.ts'], passWithNoTests: false },
});
