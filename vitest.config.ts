import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@perimeter/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.spec.ts', 'apps/desktop/renderer/src/**/*.spec.ts', 'apps/desktop/main/**/*.spec.mjs'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
