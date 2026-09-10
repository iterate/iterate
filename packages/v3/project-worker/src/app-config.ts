// ── app config ── THE WORKER'S CONFIGURATION: one typed object per isolate, read from the `APP_CONFIG_*`
// wrangler vars plus the platform-supplied deploy identity (the version-metadata binding). Loud on
// anything malformed, at first use — never a silent default.
//
// Configuration is what differs between deployments of the SAME code: the vars below and the deploy
// id. A constant (timeouts, budgets, key conventions, the loaded-worker compatibility flags) is a
// property of the code and lives beside its consumer. A var nothing reads does not exist; an
// `APP_CONFIG_*` var this file does not name is refused, so a typo can never configure nothing silently.

const APP_CONFIG_VARS = [
  "APP_CONFIG_ENVIRONMENT_NAME",
  "APP_CONFIG_PROJECT_HOSTNAME_BASE",
  "APP_CONFIG_PROJECT_TOKEN_SECRET",
  "APP_CONFIG_ARTIFACTS_ACCOUNT_ID",
  "APP_CONFIG_ARTIFACTS_NAMESPACE",
  "APP_CONFIG_SESSION_SECRET",
  "APP_CONFIG_ADMIN_API_SECRET",
  "APP_CONFIG_PLATFORM_ORIGIN",
  "APP_CONFIG_MCP_ORIGIN",
] as const;
/** One of the `APP_CONFIG_*` vars — the only names `parseAppConfig` reads. */
type AppConfigVarName = (typeof APP_CONFIG_VARS)[number];

/** THE WORKER'S CONFIGURATION: what differs between deployments of the same code, parsed once per
 *  isolate (`appConfigOf`) from the `APP_CONFIG_*` vars and the deploy identity. */
export interface AppConfig {
  /** Fixed public origins. Unset only in the existing local/test configuration. */
  readonly platformOrigin: string;
  readonly mcpOrigin: string;
  /** Which deployment this is, as a word a human reads at `/version`: "poc" (the deployment), "test"
   *  (the workers lane), "e2e" (the e2e lane). Required. */
  readonly environmentName: string;
  /** The base every project host hangs under — `<app>--<project>.<base>`, `<app>.<project>.<base>`,
   *  `<project>.<base>` (the project host section); blank ⇒ no project-host ingress. */
  readonly projectHostnameBase: string;
  /** The HMAC secret project tokens are signed with (principal.ts) — a wrangler SECRET on a deployment,
   *  a var in the test lanes. Required: a blank secret signs no token (`mintToken`, the console's
   *  project links) and verifies none. */
  readonly projectTokenSecret: string;
  /** The Cloudflare account + Artifacts namespace `itx.repos` builds git remotes from
   *  (`https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`); blank where no
   *  Artifacts binding exists (the workers lane). */
  readonly artifactsAccountId: string;
  readonly artifactsNamespace: string;
  /** The HMAC secret the control plane's session cookie is signed with (control-plane.ts) — a
   *  wrangler SECRET on a deployment, a var in the test lanes. Required: a blank secret signs no
   *  cookie and verifies none. */
  readonly sessionSecret: string;
  /** The deployment's admin secret — `authenticate({ type: "admin-secret" })` (session.ts) and the
   *  project host's admin bearer (`projectHostIdentityOf`): every project. A wrangler SECRET on a deployment, a var
   *  in the test lanes. Required: a blank secret would match nothing. */
  readonly adminApiSecret: string;
  /** Cloudflare's version id of the running deployment (`CF_VERSION_METADATA.id`; local workerd mints
   *  one too); "unversioned" where the binding is absent or blank. In every loader cacheKey and at
   *  `/version`. */
  readonly deployId: string;
}

/** The slice of `env` the configuration reads: the version-metadata binding and the vars, each an
 *  optional string. The worker's `Env` extends this. */
export type AppConfigEnv = { CF_VERSION_METADATA?: { id: string } } & {
  [Name in AppConfigVarName]?: string;
};

/** Parse the configuration out of `vars` (a worker env, or any record — only `APP_CONFIG_*` keys are
 *  read). Pure; the door every test goes through. */
export function parseAppConfig(vars: object, deployId = "unversioned"): AppConfig {
  const record = vars as Record<string, unknown>;
  for (const name of Object.keys(record))
    if (name.startsWith("APP_CONFIG_") && !(APP_CONFIG_VARS as readonly string[]).includes(name))
      throw new Error(
        `${name}: unknown configuration variable (known: ${APP_CONFIG_VARS.join(", ")})`,
      );
  const read = (name: AppConfigVarName): string => {
    const raw = record[name];
    if (raw !== undefined && typeof raw !== "string")
      throw new Error(`${name}: expected a string variable, got ${JSON.stringify(raw)}`);
    return (raw ?? "").trim();
  };
  const environmentName = read("APP_CONFIG_ENVIRONMENT_NAME");
  if (!environmentName)
    throw new Error("APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank");
  const projectTokenSecret = read("APP_CONFIG_PROJECT_TOKEN_SECRET");
  if (!projectTokenSecret)
    throw new Error("APP_CONFIG_PROJECT_TOKEN_SECRET: required, but unset or blank");
  const sessionSecret = read("APP_CONFIG_SESSION_SECRET");
  if (!sessionSecret) throw new Error("APP_CONFIG_SESSION_SECRET: required, but unset or blank");
  const adminApiSecret = read("APP_CONFIG_ADMIN_API_SECRET");
  if (!adminApiSecret) throw new Error("APP_CONFIG_ADMIN_API_SECRET: required, but unset or blank");
  const platformOrigin = read("APP_CONFIG_PLATFORM_ORIGIN");
  const mcpOrigin = read("APP_CONFIG_MCP_ORIGIN");
  for (const [name, value] of [
    ["APP_CONFIG_PLATFORM_ORIGIN", platformOrigin],
    ["APP_CONFIG_MCP_ORIGIN", mcpOrigin],
  ]) {
    if (!value) continue;
    const url = new URL(value);
    if (url.origin !== value || !["https:", "http:"].includes(url.protocol))
      throw new Error(`${name}: expected an HTTP(S) origin without a path`);
  }
  if (mcpOrigin && (!platformOrigin || mcpOrigin === platformOrigin))
    throw new Error("APP_CONFIG_MCP_ORIGIN: requires a distinct APP_CONFIG_PLATFORM_ORIGIN");
  return {
    platformOrigin,
    mcpOrigin,
    environmentName,
    projectHostnameBase: read("APP_CONFIG_PROJECT_HOSTNAME_BASE"),
    projectTokenSecret,
    artifactsAccountId: read("APP_CONFIG_ARTIFACTS_ACCOUNT_ID"),
    artifactsNamespace: read("APP_CONFIG_ARTIFACTS_NAMESPACE"),
    sessionSecret,
    adminApiSecret,
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
