import { logger } from "./backend/tag-logger.ts";

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
    // In tests, just run the promise and ignore errors
    promise.catch(() => {});
  };
}

export type CloudflareEnv = Env & {
  VITE_PUBLIC_URL: string;
  OPENAI_API_KEY: string;
  POSTHOG_API_KEY: string;
  BRAINTRUST_API_KEY: string;
  POSTHOG_PUBLIC_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_SLUG: string;
  EXPIRING_URLS_SIGNING_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  STAGE__PR_ID?: string;
  PROJECT_NAME: string;
  POSTHOG_ENVIRONMENT: string;
  EXA_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  REPLICATE_API_TOKEN: string;
  ITERATE_USER: string;
  ITERATE_NOTIFICATION_ESTATE_ID?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICING_PLAN_ID: string;
  SERVICE_AUTH_TOKEN: string;

  ITERATE_BOT_GITHUB_TOKEN: string;

  // Comma-separated list of hostnames. If a user with a verified email using that hostname signs up,
  // they get user.role=admin set. This is particularly useful for testing in development when
  // you want to test with one admin and one non-admin user over and over
  ADMIN_EMAIL_HOSTS?: string;

  // Comma-separated list of regex patterns used to detect test users.
  // Matching is case-insensitive substring across user name, email, and organization name.
  TEST_USER_PATTERNS?: string;

  // JSON object with seed data for test users
  ONBOARDING_E2E_TEST_SETUP_PARAMS?: string;
};

export const env = _env as CloudflareEnv;

/**
 * Wrapper around cloudflare:workers waitUntil that catches and logs errors.
 * Use this instead of importing waitUntil directly from "cloudflare:workers".
 *
 * @example
 * import { waitUntil } from "../env.ts";
 *
 * waitUntil((async () => {
 *   await someAsyncTask();
 * })());
 */
export function waitUntil(promise: Promise<unknown>): void {
  _waitUntil(
    promise.catch((error) => {
      logger.error("Error in waitUntil callback", error);
    }),
  );
}
