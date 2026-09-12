// ── app config ── THE WORKER'S CONFIGURATION: one typed object per isolate, parsed from the
// `APP_CONFIG_*` wrangler vars (the shared env parser, `@iterate-com/shared/config`) plus the
// platform-supplied deploy identity (the version-metadata binding). Loud on anything malformed, at
// first use — never a silent default.
//
// Configuration is what differs between deployments of the SAME code: the vars below and the deploy
// id. A constant (timeouts, budgets, key conventions, the loaded-worker compatibility flags) is a
// property of the code and lives beside its consumer. The schema field names ARE the vars, uppercased
// with `_`: `APP_CONFIG_PROJECT_HOSTNAME_BASE` → `projectHostnameBase` (the shared parser's mapping);
// an `APP_CONFIG_*` var the schema does not name is warned about loudly at boot, never silently kept.

import { parseAppConfigFromEnv, redacted, type Redacted } from "@iterate-com/shared/config";
import { z } from "zod";
import { isLocalOrigin } from "./lib.ts";

/** A field's failure message names the SHAPE; `parseAppConfig` prefixes the env var it came from. */
const REQUIRED = "required, but unset or blank";

/** An HTTP(S) origin with no path or query — `new URL(v).origin === v`. */
const httpOrigin = z
  .string()
  .trim()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  }, "expected an HTTP(S) origin without a path");

/** A REQUIRED secret (an HMAC key, an admin bearer): present, non-blank, and never printed
 *  (`Redacted` — `.exposeSecret()` at the one place it is used). A blank secret would sign/verify
 *  nothing, so it is refused at boot. */
const requiredSecret = redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED));

/** THE `APP_CONFIG_*` SCHEMA — one field per wrangler var, PER-FIELD validation only. Cross-field
 *  rules (a distinct MCP origin, Google id+secret together) and the derived `testEmailLogin` live in
 *  `parseAppConfig`, because the shared env parser needs a plain object schema to check override keys
 *  against. */
export const AppConfig = z.object({
  /** Which deployment this is, as a word a human reads at `/version`: "poc", "test" (the workers
   *  lane), "e2e". Required. */
  environmentName: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
  /** The fixed issuer/console origin. Required. */
  platformOrigin: httpOrigin,
  /** An optional separate MCP origin (blank ⇒ served on the platform origin). */
  mcpOrigin: z.union([z.literal(""), httpOrigin]).default(""),
  /** The base every project host hangs under — `<app>--<project>.<base>`, `<project>.<base>`
   *  (the project host section); blank ⇒ no project-host ingress. */
  projectHostnameBase: z.string().trim().default(""),
  /** The HMAC secret project tokens are signed with (principal.ts). */
  projectTokenSecret: requiredSecret,
  /** The HMAC secret the control plane's session cookie is signed with (control-plane.ts). */
  sessionSecret: requiredSecret,
  /** The deployment's admin secret — `authenticate({ type: "admin-secret" })` and the project host's
   *  admin bearer: every project. */
  adminApiSecret: requiredSecret,
  /** The Cloudflare account + Artifacts namespace `itx.repos` builds git remotes from; blank where no
   *  Artifacts binding exists (the workers lane). */
  artifactsAccountId: z.string().trim().default(""),
  artifactsNamespace: z.string().trim().default(""),
  googleClientId: z.string().trim().default(""),
  /** The Google OAuth client secret — a secret, blank where Google login is off. */
  googleClientSecret: redacted(z.string().trim().default("")),
  /** Assume any entered email, without verification — local development or explicit test deployments
   *  only. The parser coerces `"true"`/`"false"` to booleans, so accept either spelling; DERIVED to a
   *  boolean in `parseAppConfig` (a local platform origin turns it on regardless). */
  testEmailLogin: z
    .preprocess(
      (value) => (value === true ? "true" : value === false ? "false" : value),
      z.enum(["", "true", "false"], { error: "expected true or false" }),
    )
    .optional(),
});

/** THE WORKER'S CONFIGURATION: the parsed `APP_CONFIG_*` fields (secrets as `Redacted`), with
 *  `testEmailLogin` derived to a boolean and the deploy identity folded in. */
export type AppConfig = Omit<z.output<typeof AppConfig>, "testEmailLogin"> & {
  /** Assume any entered email, without verification: a local platform origin OR the flag set. */
  readonly testEmailLogin: boolean;
  /** Cloudflare's version id of the running deployment (`CF_VERSION_METADATA.id`; local workerd mints
   *  one too); "unversioned" where the binding is absent or blank. In every loader cacheKey and at
   *  `/version`. */
  readonly deployId: string;
};

/** The slice of `env` the configuration reads: the version-metadata binding and the `APP_CONFIG_*`
 *  vars, each an optional string. The worker's `Env` extends this. */
export type AppConfigEnv = { CF_VERSION_METADATA?: { id: string } } & {
  [Name in `APP_CONFIG_${string}`]?: string;
};

/** The `APP_CONFIG_*` var a schema field came from — the inverse of the shared parser's mapping, so a
 *  boot error names the variable a human sets, not the camelCase field. */
function envVarNameOf(path: readonly (string | number | symbol)[]): string {
  return `APP_CONFIG_${path
    .map((segment) =>
      String(segment)
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase(),
    )
    .join("__")}`;
}

/** Parse the configuration out of `env` (a worker env, or any record — only `APP_CONFIG_*` keys are
 *  read). Pure; the door every test goes through. A malformed variable throws naming itself. */
export function parseAppConfig(env: object, deployId = "unversioned"): AppConfig {
  let parsed: z.output<typeof AppConfig>;
  try {
    parsed = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: env as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      throw new Error(`${envVarNameOf(issue.path)}: ${issue.message}`);
    }
    throw error;
  }
  if (parsed.mcpOrigin && parsed.mcpOrigin === parsed.platformOrigin)
    throw new Error("APP_CONFIG_MCP_ORIGIN: requires a distinct APP_CONFIG_PLATFORM_ORIGIN");
  if (Boolean(parsed.googleClientId) !== Boolean(parsed.googleClientSecret.exposeSecret()))
    throw new Error("Google client ID and secret must be configured together.");
  const { testEmailLogin, ...rest } = parsed;
  return {
    ...rest,
    testEmailLogin: isLocalOrigin(parsed.platformOrigin) || testEmailLogin === "true",
    deployId,
  };
}

const appConfigByEnv = new WeakMap<object, AppConfig>();

/** The configuration of the isolate `env` belongs to — parsed on first use, then the same object every
 *  time (a WeakMap on the env object: a worker's `env` and a DO's `this.env` are stable for the
 *  isolate's life). A malformed variable throws HERE, on the first request or the first DO
 *  construction, naming the variable. */
export function appConfigOf(env: AppConfigEnv): AppConfig {
  let appConfig = appConfigByEnv.get(env);
  if (!appConfig) {
    appConfig = parseAppConfig(env, env.CF_VERSION_METADATA?.id?.trim() || "unversioned");
    appConfigByEnv.set(env, appConfig);
  }
  return appConfig;
}

export type { Redacted };
