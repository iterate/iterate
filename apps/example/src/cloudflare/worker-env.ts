export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VITE_POSTHOG_PUBLIC_KEY: string;
  VITE_POSTHOG_PROXY_URL: string;
  PIRATE_SECRET: string;
}
