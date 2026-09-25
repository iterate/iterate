// app-config.ts — THE APP_CONFIG MECHANISM: how every Worker of ours reads what differs between
// deployments of the same code. ONE JSON object, the `APP_CONFIG` var (or Worker secret), checked
// against the Worker's own zod schema; loud on anything malformed, naming the field — never a
// silent default.
//
// Any key can also be set ALONE as a var, the path joined by `__` and each segment in SNAKE_CASE:
// `APP_CONFIG_URLS__OS`, `APP_CONFIG_LOGIN__PASSWORD`. The parser merges it on top of the object, so
// a deployment's generated vars (envs.ts) and its secrets (Doppler) compose, and a laptop's
// gitignored `.dev.vars` names one local origin without restating the rest. A blank var is unset.
// A key the schema does not name is warned about loudly and dropped, never silently kept.
//
// The schemas: the platform's in apps/os/src/app-config.ts, the apps on top's in
// start-app-config.ts.

import { z } from "zod";

/** Parse `schema` out of `env` (a worker env, or any record — only `APP_CONFIG` and the
 *  `APP_CONFIG_*` keys are read; a blank one is unset). Pure. A malformed field throws naming
 *  itself in both spellings (`fieldNameOf`). */
export function parseAppConfigVars<Schema extends z.ZodTypeAny>(
  env: object,
  schema: Schema,
): z.output<Schema> {
  const configEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!(key === "APP_CONFIG" || key.startsWith("APP_CONFIG_"))) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    configEnv[key] = value;
  }
  try {
    const raw = deepMerge(objectOf(configEnv.APP_CONFIG), overridesOf(configEnv));
    warnUnknownKeys(raw, schema, []);
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      throw new Error(`${fieldNameOf(issue.path)}: ${issue.message}`);
    }
    throw error;
  }
}

/** Where a field came from, for a message: its path in the object and its var spelling —
 *  `APP_CONFIG urls.os (APP_CONFIG_URLS__OS)`. */
export function fieldNameOf(path: readonly PropertyKey[]): string {
  return `APP_CONFIG ${path.map(String).join(".")} (${envVarNameOf(path)})`;
}

/** An HTTP(S) origin with no path or query — `new URL(v).origin === v`. */
export const httpOrigin = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  }, "expected an HTTP(S) origin without a path");

/** An origin a deployment may leave out (blank ⇒ the field's documented default). */
export const optionalOrigin = z.union([z.literal(""), httpOrigin]).default("");

/** A DNS name: lowercase labels, no scheme, no trailing dot, no wildcard — the wildcard is implied. */
export const dnsName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/, "expected a DNS name");

/** The override var a schema path answers to — `["urls", "os"]` → `APP_CONFIG_URLS__OS` — the inverse
 *  of `overridesOf`, so a message names both spellings a human might have used. */
function envVarNameOf(path: readonly PropertyKey[]): string {
  return `APP_CONFIG_${path
    .map((segment) =>
      String(segment)
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase(),
    )
    .join("__")}`;
}

/** Warn, loudly, about a key the schema does not name — in the object or an `APP_CONFIG_*` override,
 *  checked once on the merged config. Walks the plain objects only; a record accepts any key. */
function warnUnknownKeys(raw: unknown, schema: z.ZodTypeAny, path: string[]): void {
  const object = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!object.success) return;
  // unwrap() and shape hand back loosely typed schemas; the walk checks each with instanceof
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodPrefault ||
    current instanceof z.ZodOptional
  )
    current = current.unwrap() as z.ZodTypeAny;
  if (!(current instanceof z.ZodObject)) return;
  for (const [key, value] of Object.entries(object.data)) {
    const child = current.shape[key] as z.ZodTypeAny | undefined;
    if (!child) {
      console.warn(
        `APP_CONFIG: unknown key "${[...path, key].join(".")}" — not in the schema, ignored. Remove it, or add it to the schema.`,
      );
      continue;
    }
    warnUnknownKeys(value, child, [...path, key]);
  }
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The `APP_CONFIG` object itself; blank ⇒ `{}`. */
function objectOf(appConfig: string | undefined): PlainObject {
  if (!appConfig?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(appConfig);
  } catch (error) {
    throw new Error("APP_CONFIG must be valid JSON", { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error("APP_CONFIG must be a JSON object");
  return parsed;
}

/** The `APP_CONFIG_*` overrides as one nested object: `__` separates path segments and each
 *  segment's SNAKE_CASE becomes camelCase (`APP_CONFIG_LOGIN__EMAIL_CODE__FROM` → `login.emailCode.from`).
 *  A value that reads as JSON (`true`, `false`, `null`, an object, an array, a quoted string) is
 *  parsed; anything else is the string itself. */
function overridesOf(configEnv: Record<string, string>): PlainObject {
  const overrides: PlainObject = {};
  for (const [key, value] of Object.entries(configEnv)) {
    if (!key.startsWith("APP_CONFIG_")) continue;
    const path = key
      .slice("APP_CONFIG_".length)
      .split("__")
      .map((segment) =>
        segment
          .toLowerCase()
          .split("_")
          .filter(Boolean)
          .map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
          .join(""),
      )
      .filter(Boolean);
    const last = path.pop();
    if (!last) continue;
    let target = overrides;
    for (const segment of path) {
      const existing = target[segment];
      const next: PlainObject = isPlainObject(existing) ? existing : {};
      target[segment] = next;
      target = next;
    }
    target[last] = overrideValueOf(value);
  }
  return overrides;
}

function overrideValueOf(value: string): unknown {
  const trimmed = value.trim();
  const looksLikeJson =
    ["true", "false", "null"].includes(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
  if (!looksLikeJson) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** `overrides` over `base`, plain objects merged key by key; anything else replaced whole. */
function deepMerge(base: PlainObject, overrides: PlainObject): PlainObject {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}
