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
};

export const env = _env as CloudflareEnv;
