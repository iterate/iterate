import { env as _env } from "cloudflare:workers";
import { parseConfig } from "../config.ts";
import type { CloudflareEmailBinding } from "./email.ts";

/**
 * The auth worker's runtime bindings, spelled out explicitly now that no IaC
 * framework derives them. Binding names match the generated wrangler.jsonc:
 * the `APP_CONFIG_*` keys are the env's Doppler secret names verbatim
 * (delivered via `wrangler deploy --secrets-file`, or loaded from process.env
 * by the vite plugin in local dev), plus the env-shaped origin vars generated
 * from the root envs.ts entry. Server code reads the parsed `config` below
 * instead of raw `env.*`; the raw interface exists so the D1/EMAIL bindings
 * and the config carrier keys are typed.
 */
export interface CloudflareEnv {
  /** The auth D1 database (identities, orgs, projects, OAuth clients). */
  DB: D1Database;
  /**
   * Cloudflare Email Service send binding for the email-OTP lane. Bound in
   * every wrangler env block including local dev, where miniflare simulates
   * sends (logs + local .eml files) instead of delivering real mail.
   */
  EMAIL: CloudflareEmailBinding;
  /** Public origin the worker is served from (better-auth baseURL, issuer). */
  APP_CONFIG_AUTH_APP_ORIGIN: string;
  /** Additional trusted public origin; equals APP_CONFIG_AUTH_APP_ORIGIN when deployed. */
  APP_CONFIG_PUBLIC_URL?: string;
  /** better-auth signing secret (sessions, JWTs, project-ingress tokens). */
  APP_CONFIG_BETTER_AUTH_SECRET: string;
  /** Shared secret trusted by the internal.* oRPC procedures. */
  APP_CONFIG_SERVICE_AUTH_TOKEN: string;
  /**
   * Sender domain for the email-OTP lane (must be onboarded for Email
   * Sending in the env's Cloudflare account or real sends fail).
   */
  APP_CONFIG_EMAIL_SENDER_DOMAIN: string;
  /** Glob allowlist gating who may sign up. */
  APP_CONFIG_SIGNUP_ALLOWLIST: string;
  APP_CONFIG_GOOGLE_CLIENT_ID: string;
  APP_CONFIG_GOOGLE_CLIENT_SECRET: string;
  /**
   * Glob allowlist promoting matching emails to platform admin. Optional:
   * deploys always ship it (defaulted in deploy.ts), but local dev has no
   * Doppler key — src/config.ts defaults it.
   */
  APP_CONFIG_ADMIN_ALLOWLIST?: string;
  /** "true" enables the email one-time-passcode sign-in lane. */
  APP_CONFIG_EMAIL_OTP_ENABLED?: string;
  /**
   * Deployed base domain project homepages live under (e.g. "iterate.app").
   * Optional: src/config.ts defaults it.
   */
  APP_CONFIG_PROJECT_HOSTNAME_BASE?: string;
}

export const env = _env as CloudflareEnv;

/**
 * The parsed auth runtime config (see src/config.ts). Parsed from the
 * worker's `APP_CONFIG_*` bindings at isolate startup — the same module-scope
 * timing the `auth` singleton and D1 client already rely on, so `env` is
 * populated. Server code reads `config.*` instead of raw `env.*`.
 */
export const config = parseConfig(env);
