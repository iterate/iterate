// app-config.ts — THE PROJECT WORKER'S CONFIGURATION: one typed object, parsed ONCE per isolate from
// the `APP_CONFIG_*` wrangler vars (the apps/os shape — apps/os/src/config.ts + env.ts — minus its
// schema library: zod is off this script for startup time) plus the deployment identity: an explicit
// DEPLOYMENT_ID or the version-metadata binding. Loud on anything malformed: an error names the variable and the shape
// it wanted, at first use, never a silent default.
//
// WHAT IS CONFIGURATION AND WHAT IS A CONSTANT. Configuration is what differs between deployments
// of the SAME code; a constant is a property of the code.
//   • environmentName — configuration: "poc" on workers.dev (wrangler.jsonc), "test" in the workers
//     lane (wrangler.test.jsonc), "solo" in the e2e lane (e2e/support/solo-config.ts). Served at
//     `/version` so a human and a smoke can tell deployments apart. The apps/os field of the same name.
//   • deployId — configuration: explicit `DEPLOYMENT_ID`, otherwise `CF_VERSION_METADATA.id`.
//     The celld runner hashes its prepared bundles, assets and configuration; Cloudflare supplies an id.
//     Folded into every loader cacheKey (context/worker-loader.ts: a facet built from an isolate a
//     PRIOR deployment minted cannot be called by the new parent) and served at `/version`.
//     "unversioned" where both are absent (or the platform id is blank). An explicit blank id is invalid.
//   • CODE_VERSION (src/worker.ts) — a hand-bumped deploy LABEL a smoke greps for while workers.dev
//     propagates; the code's own stamp, printed first at `/version`. Not a var: it changes with the
//     code, not the deployment.
//   • IDLE_QUIESCE_AFTER_MS, FACET_CALL_WATCHDOG_MS, the delivery retry ladder, the memory budgets,
//     the `secret:<projectId>:<name>` key convention, the loaded-worker compatibility flags —
//     CONSTANTS: properties of the design, identical in every deployment. A value that must differ
//     per deployment becomes a row here on the day it must, together with its consumer; a row nothing
//     reads does not exist.
//
// SHAPE: `APP_CONFIG_VAR_ROWS` is the table — one row per variable (its name, its parser, required
// or a default); `parseAppConfigVars` is the engine any row table runs through; `parseAppConfig` is
// THIS worker's table plus the deploy id; `appConfigOf(env)` memoizes per env object, i.e. per
// isolate. The parsers are exactly the kinds the table names — a parser no row names is the same
// speculation one level down (an integer arrives with its row and its consumer).

/** A parser from a variable's raw string to its value; on refusal it throws with `name` in the message. */
export type AppConfigVarParser<T> = (raw: string, name: string) => T;

const appConfigVarError = (name: string, expected: string, raw: string): Error =>
  new Error(`${name}: expected ${expected}, got ${JSON.stringify(raw)}`);

/** A deployment-owned hostname directory: string names pointing at string project ids. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** The parser kinds the rows name. Each trims, and each refusal says what it wanted. */
export const appConfigVarParsers = {
  string: (raw: string, name: string): string => {
    const value = raw.trim();
    if (!value) throw appConfigVarError(name, "a non-empty string", raw);
    return value;
  },
  stringRecord: (raw: string, name: string): Record<string, string> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw appConfigVarError(name, "a JSON object mapping strings to strings", raw);
    }
    if (!isStringRecord(parsed))
      throw appConfigVarError(name, "a JSON object mapping strings to strings", raw);
    return parsed;
  },
} satisfies Record<string, AppConfigVarParser<unknown>>;

/** One row of a variable table: the `APP_CONFIG_*` name, its parser, and either `required` or a
 *  `default` that stands in when the variable is unset or blank. */
export type AppConfigVarRow<T> = {
  name: `APP_CONFIG_${string}`;
  parse: AppConfigVarParser<T>;
} & ({ required: true } | { default: T });

/** What a row table parses into: one field per row, typed by its parser. */
export type ParsedAppConfigVars<Rows extends Record<string, AppConfigVarRow<unknown>>> = {
  readonly [Field in keyof Rows]: Rows[Field] extends AppConfigVarRow<infer T> ? T : never;
};

/** THE ENGINE: parse `vars` (a worker `env`, or any record — only `APP_CONFIG_*` keys are read)
 *  against `rows`. Unset or blank + a default ⇒ the default; unset or blank + required ⇒ refused; a
 *  non-string value ⇒ refused (wrangler vars may be JSON objects; a row wants a string); an
 *  `APP_CONFIG_*` variable no row names ⇒ refused, because a typo would otherwise configure nothing,
 *  silently. Pure: no memo, no env access beyond the record it is handed. */
export function parseAppConfigVars<Rows extends Record<string, AppConfigVarRow<unknown>>>(
  rows: Rows,
  vars: object,
): ParsedAppConfigVars<Rows> {
  const varsByName = vars as Record<string, unknown>;
  const knownNames = new Set<string>(Object.values(rows).map((row) => row.name));
  for (const name of Object.keys(vars))
    if (name.startsWith("APP_CONFIG_") && !knownNames.has(name))
      throw new Error(
        `${name}: unknown configuration variable (known: ${[...knownNames].sort().join(", ")})`,
      );
  const parsed: Record<string, unknown> = {};
  for (const [field, row] of Object.entries(rows)) {
    const raw = varsByName[row.name];
    if (raw !== undefined && typeof raw !== "string")
      throw appConfigVarError(row.name, "a string variable", JSON.stringify(raw));
    if (raw === undefined || raw.trim() === "") {
      if ("default" in row) {
        parsed[field] = row.default;
        continue;
      }
      throw new Error(`${row.name}: required, but ${raw === undefined ? "unset" : "blank"}`);
    }
    parsed[field] = row.parse(raw, row.name);
  }
  return parsed as ParsedAppConfigVars<Rows>;
}

/** THIS WORKER'S TABLE — adding configuration is adding a row here and its consumer. */
export const APP_CONFIG_VAR_ROWS = {
  environmentName: {
    name: "APP_CONFIG_ENVIRONMENT_NAME",
    parse: appConfigVarParsers.string,
    required: true,
  },
  projectHostnameBase: {
    name: "APP_CONFIG_PROJECT_HOSTNAME_BASE",
    parse: appConfigVarParsers.string,
    default: "localhost",
  },
  projects: {
    name: "APP_CONFIG_PROJECTS_JSON",
    parse: appConfigVarParsers.stringRecord,
    default: {},
  },
  customHostnames: {
    name: "APP_CONFIG_CUSTOM_HOSTNAMES_JSON",
    parse: appConfigVarParsers.stringRecord,
    default: {},
  },
} as const satisfies Record<string, AppConfigVarRow<unknown>>;

/** The project worker's configuration — the rows above, plus the deploy identity. */
export interface AppConfig {
  /** Which deployment this is, as a word a human reads at `/version`: "poc" (workers.dev), "test"
   *  (the workers lane), "solo" (the e2e lane). `APP_CONFIG_ENVIRONMENT_NAME`. */
  readonly environmentName: string;
  /** Explicit `DEPLOYMENT_ID`, otherwise Cloudflare's version id (`CF_VERSION_METADATA.id`).
   *  "unversioned" where neither supplies an identity. In every loader cacheKey and at `/version`. */
  readonly deployId: string;
  /** Deployment-owned wildcard base for project hosts, e.g. `iterate2.app` or `localhost`. */
  readonly projectHostnameBase: string;
  /** Deployment-owned slug → project-id map. HTTP request headers never contribute to this table. */
  readonly projects: Readonly<Record<string, string>>;
  /** Deployment-owned exact custom hostname → project-id map. */
  readonly customHostnames: Readonly<Record<string, string>>;
}

/** Parse this worker's table out of `vars`, with the resolved deploy identity handed in by
 *  `appConfigOf`. Pure; the door every test goes through. */
export function parseAppConfig(vars: object, deployId = "unversioned"): AppConfig {
  return { ...parseAppConfigVars(APP_CONFIG_VAR_ROWS, vars), deployId };
}

/** The names of this worker's variables, from the table. */
export type AppConfigVarName =
  (typeof APP_CONFIG_VAR_ROWS)[keyof typeof APP_CONFIG_VAR_ROWS]["name"];

/** The slice of `env` the configuration reads: an explicit deployment id, the version-metadata
 *  binding (wrangler `version_metadata`) and the table's variables. The worker's `Env`
 *  extends this, so a new row types itself onto `env`. */
export type AppConfigEnv = { CF_VERSION_METADATA?: { id: string }; DEPLOYMENT_ID?: string } & {
  [Name in AppConfigVarName]?: string;
};

const appConfigByEnv = new WeakMap<object, AppConfig>();

/** The configuration of the isolate `env` belongs to — parsed on first use, then the same object
 *  every time (a WeakMap on the env object: a worker's `env` and a DO's `this.env` are stable for
 *  the isolate's life). A malformed variable throws HERE, on the first request or the first DO
 *  construction, naming the variable. */
export function appConfigOf(env: AppConfigEnv): AppConfig {
  let appConfig = appConfigByEnv.get(env);
  if (!appConfig) {
    appConfig = parseAppConfig(env, deploymentIdOf(env, env.CF_VERSION_METADATA?.id));
    appConfigByEnv.set(env, appConfig);
  }
  return appConfig;
}

/** Both Worker artifacts need cache identities. Self-hosted builds supply an explicit content
 * hash; Cloudflare supplies version metadata. An explicitly configured blank ID is a mistake. */
export function deploymentIdOf(
  env: { DEPLOYMENT_ID?: string },
  platformVersionId: string | undefined,
): string {
  if (env.DEPLOYMENT_ID !== undefined)
    return appConfigVarParsers.string(env.DEPLOYMENT_ID, "DEPLOYMENT_ID");
  return platformVersionId?.trim() || "unversioned";
}
