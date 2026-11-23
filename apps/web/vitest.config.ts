import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.spec.ts', 'lint/**/*.spec.ts'], passWithNoTests: false },
});
