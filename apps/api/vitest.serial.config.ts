import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Same setup as the main config, but only the suites that move the shared clock, one file at a time.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/**/*.serial.spec.ts'], fileParallelism: false },
});
