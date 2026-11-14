import { defineConfig } from 'vite';
export default defineConfig({
  root: 'apps/reference-chat',
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1' },
});
