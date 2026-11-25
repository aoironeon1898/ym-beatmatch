import { defineConfig } from '@playwright/test';

// Keep Playwright's default discovery (repo root, incl. src/plugins/**/*.test.*),
// but leave tests/unit to vitest (`pnpm test:unit`).
export default defineConfig({
  testIgnore: ['**/tests/unit/**'],
});
