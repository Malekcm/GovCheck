import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Each PGlite worker hosts PostgreSQL/WASM. Bound memory on developer machines.
    maxWorkers: 2,
  },
});
