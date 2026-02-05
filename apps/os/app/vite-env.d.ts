/// <reference types="vite/client" />

interface ViteTypeOptions {
  strictImportMetaEnv: true;
}

// Explicit VITE_* env vars - alchemy type inference loses these through the spread
interface ImportMetaEnv {
  readonly VITE_PUBLIC_URL: string;
  readonly VITE_APP_STAGE: string;
  readonly VITE_DAYTONA_SNAPSHOT_NAME?: string;
  readonly VITE_ENABLE_EMAIL_OTP_SIGNIN?: "true" | "false";
  readonly VITE_POSTHOG_PUBLIC_KEY?: string;
  readonly VITE_POSTHOG_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../backend/worker");
  }
}
