import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Unit tests for pure / injectable modules (ym-beatmatch). Playwright e2e stays in tests/*.test.js.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
