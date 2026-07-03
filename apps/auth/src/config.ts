import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { z } from "zod/v4";

/**
 * Auth worker runtime config, parsed from the `APP_CONFIG` JSON blob plus
 * `APP_CONFIG_*` env overrides that alchemy bakes into the worker at deploy time
 * (e.g. `APP_CONFIG_BETTER_AUTH_SECRET`, `APP_CONFIG_AUTH_APP_ORIGIN`). Mirrors
 * apps/os's `src/config.ts` so both apps share one config mechanism.
 *
 * `publicValue` fields may be exposed to the browser (e.g. the login page reads
 * `emailOtpEnabled`); `redacted` fields parse into `Redacted` wrappers that must
 * be unwrapped with `.exposeSecret()` and never serialize their value. Plain
 * fields (allowlists) are server-only but not secret.
 *
 * Note: the browser bundle's own origin still comes from the build-time
 * `import.meta.env.VITE_AUTH_APP_ORIGIN` (utils/auth-client.ts, utils/query.tsx)
 * — that is a Vite-inlined client concern, separate from this runtime config,
 * the same way apps/os keeps `VITE_APP_STAGE` as a build var.
 */
export const AppConfig = z.object({
  /** Public origin the auth worker is served from — better-auth `baseURL`, CORS
   * allow-list, and the OIDC issuer (`${origin}/api/auth`) all derive from it. */
  authAppOrigin: publicValue(z.url()),
  /** Optional additional public origin (e.g. a vanity domain) trusted for CORS
   * and logout redirects. Defaults to `authAppOrigin` when unset. */
  publicUrl: publicValue(z.url()).optional(),
  /** better-auth signing secret (sessions, JWTs, project-ingress tokens). */
  betterAuthSecret: redacted(z.string().trim().min(1)),
  /** Shared secret trusted by the `internal.*` oRPC procedures and the
   * bootstrap-admin sign-in. */
  serviceAuthToken: redacted(z.string().trim().min(1)),
  googleClientId: publicValue(z.string().trim().min(1)),
  googleClientSecret: redacted(z.string().trim().min(1)),
  /** Sender domain for the email-OTP lane, used with Cloudflare Email Service. */
  emailSenderDomain: z.string().trim().default(""),
  /** Legacy Resend sender domain / API key for the email-OTP lane fallback. */
  resendDomain: z.string().trim().default(""),
  resendApiKey: redacted(z.string().default("")),
  /** Glob allowlist gating who may sign up. */
  signupAllowlist: z.string().default(""),
  /** Glob allowlist promoting matching emails to platform admin. */
  adminAllowlist: z.string().trim().default("*@nustom.com"),
  /** Whether the email one-time-passcode sign-in lane is offered. */
  emailOtpEnabled: publicValue(z.boolean().default(false)),
  /** Deployed base domain project homepages live under (e.g. "iterate.app",
   * "iterate-preview-3.app") — onboarding previews "<slug>.<base>". Mirrors
   * os's APP_CONFIG_PROJECT_HOSTNAME_BASES. */
  projectHostnameBase: publicValue(z.string().trim().min(1).default("iterate.app")),
});

export type AppConfig = z.output<typeof AppConfig>;

/**
 * Parse auth config from a worker `env` (the `cloudflare:workers` import or a
 * Hono `c.env` — both `APP_CONFIG_*` carriers). Accepts `unknown` so callers
 * don't need a cast at every site.
 */
export function parseConfig(env: unknown): AppConfig {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
}
