/// <reference types="vitest" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend talks to the EPGHub API server (Hono, default :3000).
// Mirakurun and TVDB are consumed server-side; the browser never touches
// them directly.
const API = process.env.EPGHUB_API_URL ?? 'http://localhost:3000';

// Expose package.json version at build time as a replacement constant so
// the Shell brand subtitle can display the real version without pulling
// the whole package.json into the client bundle.
const pkgUrl = new URL('./package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version: string };

// GitHub Pages serves this project site at /<repo>/ — when EPGHUB_BASE is
// set the mock build resolves assets + router routes to that sub-path.
const BASE = process.env.EPGHUB_BASE ?? '/';

export default defineConfig({
  plugins: [react()],
  base: BASE,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      // Pass through the server's OpenAPI surface so users can hit
      // http://localhost:5173/docs (the same origin as the UI) instead of
      // having to know the :3000 backend port.
      '/docs': { target: API, changeOrigin: true },
      '/openapi.json': { target: API, changeOrigin: true },
      '/openapi.yaml': { target: API, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
});
