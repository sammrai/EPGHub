/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_NOW?: string;
  readonly VITE_USE_FIXTURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected at build time from package.json via vite.config.ts → define.
declare const __APP_VERSION__: string;
