import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'data', 'tests/run.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000,
  },
});
