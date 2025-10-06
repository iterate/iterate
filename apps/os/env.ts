import { env as _env } from "cloudflare:workers";

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
  EXA_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  REPLICATE_API_TOKEN: string;
  ITERATE_USER: string;
  ITERATE_NOTIFICATION_ESTATE_ID?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICING_PLAN_ID: string;

  // Comma-separated list of hostnames. If a user with a verified email using that hostname signs up,
  // they get user.role=admin set. This is particularly useful for testing in development when
  // you want to test with one admin and one non-admin user over and over
  ADMIN_EMAIL_HOSTS?: string;

  // Comma-separated list of regex patterns used to detect test users.
  // Each pattern is applied to user name, email, and organization name.
  TEST_USER_PATTERNS?: string;
};

export const env = _env as CloudflareEnv;
