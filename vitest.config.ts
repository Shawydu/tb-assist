import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // use `// @vitest-environment happy-dom` per file
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**', '.output/**'],
    passWithNoTests: true,
  },
});
