import { defineConfig } from 'vitest/config';
import path from 'path';
// The suite's file pattern is shared with scripts/check-ts-test-skips.mjs, which needs the same answer
// from the FILESYSTEM to tell a narrowed run from a complete one (#220). One definition, two readers.
import { TEST_INCLUDE } from './scripts/test-include.mjs';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [TEST_INCLUDE],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    conditions: ['node'],
    alias: {
      // Resolve dynamic requires in DBHandler.ts
      './drivers/postgres': path.resolve(__dirname, 'src/drivers/postgres'),
      './drivers/sqlite': path.resolve(__dirname, 'src/drivers/sqlite'),
      './drivers/SqliteHelper': path.resolve(__dirname, 'src/drivers/SqliteHelper'),
      './drivers/PostgresHelper': path.resolve(__dirname, 'src/drivers/PostgresHelper'),
    },
  },
});

