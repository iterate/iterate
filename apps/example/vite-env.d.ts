/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POSTHOG_PUBLIC_KEY?: string;
  readonly VITE_POSTHOG_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
