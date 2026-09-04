// app-config.ts — THE PROJECT WORKER'S CONFIGURATION: one typed object, parsed ONCE per isolate from
// the `APP_CONFIG_*` wrangler vars (the apps/os shape — apps/os/src/config.ts + env.ts — minus its
// schema library: zod is off this script for startup time, BUILD-LOG 2026-09-03 W3(b)) plus the one
// platform-supplied identity, the version-metadata binding. Loud on anything malformed: an error
// names the variable and the shape it wanted, at first use, never a silent default.
//
// WHAT IS CONFIGURATION AND WHAT IS A CONSTANT (the inventory of 2026-09-04). Configuration is what
// differs between deployments of the SAME code; a constant is a property of the code.
//   • environmentName — configuration: "poc" on workers.dev (wrangler.jsonc), "test" in the workers
//     lane (wrangler.test.jsonc), "solo" in the e2e lane (e2e/support/solo-config.ts). Served at
//     `/version` so a human and a smoke can tell deployments apart. The apps/os field of the same name.
//   • deployId — configuration, platform-supplied: `CF_VERSION_METADATA.id` changes on every deploy.
//     Folded into every loader cacheKey (context/worker-loader.ts: a facet built from an isolate a
//     PRIOR deployment minted cannot be called by the new parent) and served at `/version`.
//     "unversioned" where the binding is absent or blank (a bare test env; local workerd mints an id).
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
// or a default); `parseAppConfigVars` is the engine any row table runs through (the test exercises
// every parser kind with its own rows); `parseAppConfig` is THIS worker's table plus the deploy id;
// `appConfigOf(env)` memoizes per env object, i.e. per isolate.

/** A parser from a variable's raw string to its value; on refusal it throws with `name` in the message. */
export type AppConfigVarParser<T> = (raw: string, name: string) => T;

const appConfigVarError = (name: string, expected: string, raw: string): Error =>
  new Error(`${name}: expected ${expected}, got ${JSON.stringify(raw)}`);

/** The whole parser toolkit — the kinds a row may name. Each trims, and each refusal says what it
 *  wanted. `json` hands back `unknown`: the consumer narrows it (a row's `parse` may wrap it). */
export const appConfigVarParsers = {
  string: (raw: string, name: string): string => {
    const value = raw.trim();
    if (!value) throw appConfigVarError(name, "a non-empty string", raw);
    return value;
  },
  integer: (raw: string, name: string): number => {
    const value = raw.trim();
    if (!/^-?\d+$/.test(value)) throw appConfigVarError(name, "an integer", raw);
    return Number(value);
  },
  boolean: (raw: string, name: string): boolean => {
    const value = raw.trim();
    if (value === "true") return true;
    if (value === "false") return false;
    throw appConfigVarError(name, '"true" or "false"', raw);
  },
  url: (raw: string, name: string): string => {
    try {
      return new URL(raw.trim()).toString();
    } catch {
      throw appConfigVarError(name, "an absolute URL", raw);
    }
  },
  json: (raw: string, name: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw appConfigVarError(name, "JSON", raw);
    }
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
} as const satisfies Record<string, AppConfigVarRow<unknown>>;

/** The project worker's configuration — the rows above, plus the deploy identity. */
export interface AppConfig {
  /** Which deployment this is, as a word a human reads at `/version`: "poc" (workers.dev), "test"
   *  (the workers lane), "solo" (the e2e lane). `APP_CONFIG_ENVIRONMENT_NAME`. */
  readonly environmentName: string;
  /** Cloudflare's version id of the running deployment (`CF_VERSION_METADATA.id`; local workerd
   *  mints one too); "unversioned" where the binding is absent or blank. In every loader cacheKey
   *  and at `/version`. */
  readonly deployId: string;
}

/** Parse this worker's table out of `vars`, with the deploy identity handed in (it is a binding, not
 *  a var — `appConfigOf` reads it). Pure; the door every test goes through. */
export function parseAppConfig(vars: object, deployId = "unversioned"): AppConfig {
  return { ...parseAppConfigVars(APP_CONFIG_VAR_ROWS, vars), deployId };
}

/** The names of this worker's variables, from the table. */
export type AppConfigVarName =
  (typeof APP_CONFIG_VAR_ROWS)[keyof typeof APP_CONFIG_VAR_ROWS]["name"];

/** The slice of `env` the configuration reads: the version-metadata binding (wrangler
 *  `version_metadata`) and the table's variables, each an optional string. The worker's `Env`
 *  extends this, so a new row types itself onto `env`. */
export type AppConfigEnv = { CF_VERSION_METADATA?: { id: string } } & {
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
    appConfig = parseAppConfig(env, env.CF_VERSION_METADATA?.id?.trim() || "unversioned");
    appConfigByEnv.set(env, appConfig);
  }
  return appConfig;
}
