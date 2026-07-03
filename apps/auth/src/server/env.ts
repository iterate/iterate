import { env as _env } from "cloudflare:workers";

/**
 * The auth worker's runtime bindings, spelled out explicitly now that no IaC
 * framework derives them. Binding names match the generated wrangler.jsonc:
 * the `APP_CONFIG_*` keys are the env's Doppler secret names verbatim
 * (delivered via `wrangler deploy --secrets-file`, or loaded from process.env
 * by the vite plugin in local dev), and the VITE_-prefixed origins are
 * env-shaped `vars` generated from the root envs.ts entry (the prefix is
 * load-bearing — the client bundle inlines them at build time).
 */
export interface CloudflareEnv {
  /** The auth D1 database (identities, orgs, projects, OAuth clients). */
  DB: D1Database;
  /** Public origin the worker is served from (better-auth baseURL, issuer). */
  VITE_AUTH_APP_ORIGIN: string;
  /** Additional trusted public origin; equals VITE_AUTH_APP_ORIGIN when deployed. */
  VITE_PUBLIC_URL: string;
  /** better-auth signing secret (sessions, JWTs, project-ingress tokens). */
  APP_CONFIG_BETTER_AUTH_SECRET: string;
  /** Shared secret trusted by the internal.* oRPC procedures. */
  APP_CONFIG_SERVICE_AUTH_TOKEN: string;
  /** Resend sender domain / API key for the email-OTP lane. */
  APP_CONFIG_RESEND_DOMAIN: string;
  APP_CONFIG_RESEND_API_KEY: string;
  /** Glob allowlist gating who may sign up. */
  APP_CONFIG_SIGNUP_ALLOWLIST: string;
  APP_CONFIG_GOOGLE_CLIENT_ID: string;
  APP_CONFIG_GOOGLE_CLIENT_SECRET: string;
  /**
   * Glob allowlist promoting matching emails to platform admin. Optional:
   * deploys always ship it (defaulted in deploy.ts), but local dev has no
   * Doppler key — the read site falls back to DEFAULT_ADMIN_ALLOWLIST.
   */
  APP_CONFIG_ADMIN_ALLOWLIST?: string;
  /** "true" enables the email one-time-passcode sign-in lane. */
  APP_CONFIG_EMAIL_OTP_ENABLED?: string;
}

export const env = _env as CloudflareEnv;
