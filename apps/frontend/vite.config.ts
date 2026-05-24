import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev: proxy API + WS requests to the backend on :3000, so the browser only
// ever talks to localhost:5173 (same-origin) and cookies flow naturally.
// In prod: the backend serves the built bundle, so no proxy is needed.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, secure: false },
      '/webhooks': { target: 'http://localhost:3000', changeOrigin: true, secure: false },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
      '/readyz': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
    outDir: 'dist',
  },
});
