/**
 * Backend Cloudflare Environment Type
 *
 * This file defines the CloudflareEnv interface for backend code without
 * depending on alchemy.run.ts, which imports TanStack modules.
 *
 * Keep this in sync with the bindings defined in alchemy.run.ts.
 */

// DurableObjectNamespace type - using any to avoid cloudflare:workers import issues in non-worker contexts
type DurableObjectNamespace = any;

// Conditionally import cloudflare:workers - it's not available in test environment
let _env: any;
let _waitUntil: any;

try {
  const cloudflareWorkers = await import("cloudflare:workers");
  _env = cloudflareWorkers.env;
  _waitUntil = cloudflareWorkers.waitUntil;
} catch {
  // In test environment or when cloudflare:workers is not available, provide mocks
  _env = {};
  _waitUntil = (promise: Promise<unknown>) => {
    promise.catch(() => {});
  };
}

/**
 * Cloudflare Worker environment bindings.
 * This interface should match the bindings configured in alchemy.run.ts.
 */
export interface CloudflareEnv {
  // Database
  DATABASE_URL: string;

  // Auth
  BETTER_AUTH_SECRET: string;

  // Daytona
  DAYTONA_API_KEY: string;
  DAYTONA_SNAPSHOT_NAME?: string;
  DAYTONA_SANDBOX_AUTO_STOP_INTERVAL?: string;
  DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL?: string;

  // OAuth providers
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;

  // AI providers
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;

  // Stripe
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_METERED_PRICE_ID: string;

  // Resend
  RESEND_ALPHAITERATECOM_API_KEY: string;
  RESEND_WEBHOOK_SECRET?: string;

  // PostHog
  POSTHOG_PUBLIC_KEY?: string;

  // Encryption
  ENCRYPTION_SECRET: string;

  // Public URLs and configuration
  VITE_PUBLIC_URL: string;
  VITE_APP_STAGE: string;
  VITE_POSTHOG_PUBLIC_KEY?: string;
  VITE_POSTHOG_PROXY_URL?: string;
  VITE_ENABLE_EMAIL_OTP_SIGNIN?: string;

  // Access control
  SIGNUP_ALLOWLIST: string;
  ALLOWED_DOMAINS: string;

  // Dev mode
  ITERATE_DEV_GIT_REF?: string;

  // Durable Objects
  REALTIME_PUSHER: DurableObjectNamespace;

  // Worker loader (for service bindings)
  WORKER_LOADER: unknown;

  // Assets (TanStack Start)
  ASSETS: unknown;
}

export const env = _env as CloudflareEnv;

/**
 * Wrapper around cloudflare:workers waitUntil that catches and logs errors.
 */
export function waitUntil(promise: Promise<unknown>): void {
  _waitUntil(
    promise.catch((error) => {
      // eslint-disable-next-line no-console -- low-level helper, can't import logger (circular dep)
      console.error("waitUntil error:", error);
    }),
  );
}

// Environment detection helpers
// import.meta.env types vary by bundler, cast through unknown for compatibility
const stage =
  (import.meta as unknown as { env?: { VITE_APP_STAGE?: string } }).env?.VITE_APP_STAGE ?? "";
export const isProduction = ["prd", "production", "prod"].includes(stage);
export const isNonProd = !isProduction;
