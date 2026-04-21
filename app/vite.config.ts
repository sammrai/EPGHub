/// <reference types="vitest" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend talks to the epghub API server (Hono, default :3000).
// That server re-exports the recording core's capabilities and adds TVDB.
// Mirakurun and the legacy EPGStation HTTP surface are consumed server-side,
// never from the browser.
const API = process.env.EPGHUB_API_URL ?? 'http://localhost:3000';

// Expose package.json version at build time as a replacement constant so
// the Shell brand subtitle can display the real version without pulling
// the whole package.json into the client bundle.
const pkgUrl = new URL('./package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
