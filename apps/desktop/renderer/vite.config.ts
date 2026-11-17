import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@perimeter/protocol': fileURLToPath(new URL('../../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  build: { outDir: '../dist-renderer', emptyOutDir: true },
});
