// app-config.ts — THE WORKER'S CONFIGURATION: one typed object per isolate, read from the `APP_CONFIG_*`
// wrangler vars plus the platform-supplied deploy identity (the version-metadata binding). Loud on
// anything malformed, at first use — never a silent default.
//
// Configuration is what differs between deployments of the SAME code: the three vars below and the
// deploy id. A constant (timeouts, budgets, key conventions, the loaded-worker compatibility flags) is a
// property of the code and lives beside its consumer. A var nothing reads does not exist; an
// `APP_CONFIG_*` var this file does not name is refused, so a typo can never configure nothing silently.

const APP_CONFIG_VARS = [
  "APP_CONFIG_ENVIRONMENT_NAME",
  "APP_CONFIG_PROJECT_HOSTNAME_BASE",
  "APP_CONFIG_PROJECT_TOKEN_SECRET",
] as const;
type AppConfigVarName = (typeof APP_CONFIG_VARS)[number];

export interface AppConfig {
  /** Which deployment this is, as a word a human reads at `/version`: "poc" (workers.dev), "test"
   *  (the workers lane), "e2e" (the e2e lane). Required. */
  readonly environmentName: string;
  /** The base every project host hangs under — `<app>--<slug>.<base>` (project-host.ts); blank ⇒ no
   *  project-host ingress (the workers lane). */
  readonly projectHostnameBase: string;
  /** The HMAC secret project tokens are signed with (principal.ts) — a wrangler SECRET on a deployment,
   *  a var in the e2e lane; blank ⇒ no token verifies, sessions stay anonymous. */
  readonly projectTokenSecret: string;
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
  return {
    environmentName,
    projectHostnameBase: read("APP_CONFIG_PROJECT_HOSTNAME_BASE"),
    projectTokenSecret: read("APP_CONFIG_PROJECT_TOKEN_SECRET"),
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
