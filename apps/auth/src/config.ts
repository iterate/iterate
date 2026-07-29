import { parseAppConfigFromEnv, publicValue, redacted, Redacted } from "@iterate-com/shared/config";
import { z } from "zod/v4";
import { parseAuthSigningEs256PrivateJwk } from "../../../scripts/lib/bake-auth-jwks.ts";

/**
 * Default glob allowlist promoting matching emails to platform admin.
 * Exported for scripts/deploy.ts, which always ships an explicit value so
 * the bootstrap-admin seed SQL and the runtime agree.
 */
export const DEFAULT_ADMIN_ALLOWLIST = "*@nustom.com";

/**
 * Auth worker runtime config, parsed from the worker's `APP_CONFIG_*` bindings
 * (the env's Doppler secret names shipped via `wrangler deploy --secrets-file`,
 * plus env-shaped vars generated from the root envs.ts — e.g.
 * `APP_CONFIG_BETTER_AUTH_SECRET`, `APP_CONFIG_AUTH_APP_ORIGIN`). Mirrors
 * apps/os's `src/config.ts` so both apps share one config mechanism.
 *
 * `publicValue` fields may be exposed to the browser (e.g. the login page reads
 * `emailOtpEnabled`); `redacted` fields parse into `Redacted` wrappers that must
 * be unwrapped with `.exposeSecret()` and never serialize their value. Plain
 * fields (allowlists) are server-only but not secret.
 *
 * Note: the browser bundle's own origin is inlined from
 * `APP_CONFIG_AUTH_APP_ORIGIN` by vite.config.ts.
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
  /**
   * Dedicated signing secret for project-app-session tokens, shared with the
   * os app so it verifies them locally (no validate RPC on hot paths).
   * Deliberately not the better-auth master secret: it grants only this
   * token kind and rotates alone. Unset: mint/validate fall back to
   * betterAuthSecret (and os keeps calling validate here).
   */
  projectAppSessionSecret: redacted(z.string().trim().min(1)).optional(),
  /** Shared secret trusted by the `internal.*` oRPC procedures and the
   * bootstrap-admin sign-in. */
  serviceAuthToken: redacted(z.string().trim().min(1)),
  googleClientId: publicValue(z.string().trim().min(1)),
  googleClientSecret: redacted(z.string().trim().min(1)),
  /** Sender domain for the email-OTP lane, used with Cloudflare Email Service.
   * Must be onboarded/verified in Email Service or OTP sends fail. */
  emailSenderDomain: z.string().trim().default(""),
  /** Glob allowlist gating who may sign up. */
  signupAllowlist: z.string().default(""),
  /** Glob allowlist promoting matching emails to platform admin. */
  adminAllowlist: z.string().trim().default(DEFAULT_ADMIN_ALLOWLIST),
  /** Whether the email one-time-passcode sign-in lane is offered. */
  emailOtpEnabled: publicValue(z.boolean().default(false)),
  /** Whether `+test@nustom.com` emails accept the fixed test OTP instead of
   * sending mail. Intended only for local/dev/preview automation. */
  fixedTestOtpEnabled: z.boolean().default(false),
  /** Deployed base domain project homepages live under (e.g. "iterate.app",
   * "iterate-preview-3.app") — onboarding previews "<slug>.<base>". Mirrors
   * os's APP_CONFIG_PROJECT_HOSTNAME_BASES. */
  projectHostnameBase: publicValue(z.string().trim().min(1).default("iterate.app")),
});

export type AppConfig = z.output<typeof AppConfig> & {
  /**
   * The single Doppler-owned ES256 (P-256) key Better Auth signs every JWT
   * with. ES256 is the sole algorithm (Cloudflare Access rejects EdDSA); its
   * public half is the only key in the JWKS.
   */
  authSigningEs256PrivateJwk: Redacted<string>;
};

/**
 * Parse auth config from a worker `env` (the `cloudflare:workers` import or a
 * Hono `c.env` — both `APP_CONFIG_*` carriers). Accepts `unknown` so callers
 * don't need a cast at every site.
 */
export function parseConfig(env: unknown): AppConfig {
  const rawEnv = env as Record<string, unknown>;
  const es256PrivateJwk = rawEnv.AUTH_FORGE_ES256_PRIVATE_JWK;
  if (typeof es256PrivateJwk !== "string" || es256PrivateJwk.trim() === "") {
    throw new Error("AUTH_FORGE_ES256_PRIVATE_JWK is required");
  }
  // Validate its shape now (fail fast).
  parseAuthSigningEs256PrivateJwk(es256PrivateJwk);

  return {
    ...parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: rawEnv,
    }),
    authSigningEs256PrivateJwk: new Redacted(es256PrivateJwk),
  };
}
