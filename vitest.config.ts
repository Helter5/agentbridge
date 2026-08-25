import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
