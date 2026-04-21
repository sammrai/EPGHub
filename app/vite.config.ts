/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend talks to the epghub API server (Hono, default :3000).
// That server re-exports the recording core's capabilities and adds TVDB.
// Mirakurun and the legacy EPGStation HTTP surface are consumed server-side,
// never from the browser.
const API = process.env.EPGHUB_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
});
