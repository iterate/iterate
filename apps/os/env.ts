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
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_SLUG: string;
  GITHUB_WEBHOOK_SECRET: string;

  EXA_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
};

export const env = _env as CloudflareEnv;
