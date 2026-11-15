import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: 'apps/reference-chat',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve('apps/reference-chat/index.html'),
        v2: resolve('apps/reference-chat/v2.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
});
