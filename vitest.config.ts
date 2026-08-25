import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several core functions now serialize writes through the single
    // shared ~/.agentsync/.lock lockfile (see withLock() usage in
    // rules.ts/skill-linker.ts/rollback.ts). Running test files in
    // parallel workers would make unrelated test files contend for that
    // same real lockfile and silently no-op each other's writes, so test
    // files run sequentially in one process instead.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'dist/**',
        'tests/**',
        'node_modules/**',
        'tsup.config.ts',
        'vitest.config.ts',
        'src/types/**',
        'src/index.ts',
        'src/templates/**',
      ],
    },
  },
});
