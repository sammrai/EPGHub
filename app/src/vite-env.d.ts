/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_NOW?: string;
  readonly VITE_USE_FIXTURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
