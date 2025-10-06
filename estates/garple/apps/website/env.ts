import { env as cloudflareEnv } from "cloudflare:workers";

export type CloudflareEnv = {
  D1: D1Database;
  ASSETS: Fetcher;
  STRIPE_GARPLECOM_SECRET_KEY: string;
  STRIPE_GARPLECOM_WEBHOOK_SIGNING_SECRET_CHECKOUT_COMPLETED: string;
  RESEND_GARPLECOM_API_KEY: string;
};

export const env = cloudflareEnv as CloudflareEnv;
