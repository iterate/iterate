import type { SimplifyDeep, Tagged } from "type-fest";
import { z } from "zod";
import { AppLogsConfig } from "./logging/types.ts";

const nodeInspectCustom = Symbol.for("nodejs.util.inspect.custom");
const configVisibilityMetaKey = "iterateConfigVisibility";
const publicConfigTag = "iterate-public-config";
const APP_CONFIG_KEY = "APP_CONFIG";
const APP_CONFIG_ENV_PREFIX = `${APP_CONFIG_KEY}_`;
const ENV_PATH_SEPARATOR = "__";

type ConfigVisibility = "public" | "redacted";
type AppConfigEnv = Record<string, unknown>;
type AppConfigObject = Record<string, unknown>;
type AppConfigPath = string[];

interface AppConfigSchemaMetadata {
  visibility: ConfigVisibility;
  baseSchema?: z.ZodTypeAny;
}

type NoPublicFields = "__no_public_fields__";

type UnpublicConfigDeep<T> =
  T extends Tagged<infer TValue, typeof publicConfigTag>
    ? UnpublicConfigDeep<TValue>
    : T extends readonly (infer TItem)[]
      ? T extends (infer _TMutableItem)[]
        ? UnpublicConfigDeep<TItem>[]
        : ReadonlyArray<UnpublicConfigDeep<TItem>>
      : T extends object
        ? { [K in keyof T]: UnpublicConfigDeep<T[K]> }
        : T;

type IsPlainObject<T> = T extends readonly unknown[] ? false : T extends object ? true : false;

type RawPublicAppConfig<T> = T extends object
  ? {
      [K in keyof T as T[K] extends PublicConfigValue<any>
        ? K
        : IsPlainObject<T[K]> extends true
          ? keyof RawPublicAppConfig<T[K]> extends never
            ? never
            : K
          : never]: T[K] extends PublicConfigValue<any>
        ? UnpublicConfigDeep<T[K]>
        : IsPlainObject<T[K]> extends true
          ? RawPublicAppConfig<T[K]>
          : NoPublicFields;
    }
  : never;

const appConfigSchemaMetadata = new WeakMap<z.ZodTypeAny, AppConfigSchemaMetadata>();

/**
 * Shared base runtime config for app-style projects.
 *
 * App-local schemas should extend this instead of redefining the log shape.
 * `logs.stdoutFormat` is intentionally tiny and consumed directly by the app
 * runtime code.
 */
export const BaseAppConfig = z.object({
  logs: AppLogsConfig.default({
    stdoutFormat: "pretty",
    filtering: {
      rules: [],
    },
  }),
});

export type BaseAppConfig = z.infer<typeof BaseAppConfig>;

export class Redacted<T = unknown> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  exposeSecret(): T {
    return this.#value;
  }

  toString(): string {
    return "REDACTED";
  }

  toJSON(): string {
    return "REDACTED";
  }

  [nodeInspectCustom](): string {
    return "Redacted {}";
  }
}

export type PublicConfigValue<T> = Tagged<T, typeof publicConfigTag>;
export type PublicAppConfig<T> = SimplifyDeep<RawPublicAppConfig<T>>;

function addConfigSchemaMetadata<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  metadata: AppConfigSchemaMetadata,
): TSchema {
  const taggedSchema = schema.meta({
    [configVisibilityMetaKey]: metadata.visibility,
  }) as TSchema;
  appConfigSchemaMetadata.set(taggedSchema, metadata);
  return taggedSchema;
}

function getConfigSchemaMetadata(schema: z.ZodTypeAny) {
  return appConfigSchemaMetadata.get(schema);
}

function isPlainObject(value: unknown): value is AppConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEnvSegment(segment: string) {
  const words = segment
    .trim()
    .toLowerCase()
    .split("_")
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return "";
  }

  return words
    .map((word, index) => (index === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`))
    .join("");
}

function parseEnvOverrideValue(rawValue: string): unknown {
  const trimmedValue = rawValue.trim();
  const canParseJson =
    trimmedValue === "true" ||
    trimmedValue === "false" ||
    trimmedValue === "null" ||
    trimmedValue.startsWith("{") ||
    trimmedValue.startsWith("[") ||
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"'));

  if (!canParseJson) {
    return rawValue;
  }

  try {
    return JSON.parse(trimmedValue) as unknown;
  } catch {
    return rawValue;
  }
}

function parseRawAppConfig(rawConfig: string | undefined, envKey = APP_CONFIG_KEY) {
  if (typeof rawConfig !== "string" || rawConfig.trim() === "") {
    return {};
  }

  let parsedConfig: unknown;

  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    throw new Error(`${envKey} must be valid JSON`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsedConfig)) {
    throw new Error(`${envKey} must be a JSON object`);
  }

  return parsedConfig;
}

function extractPublicConfigSchemaInternal(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const metadata = getConfigSchemaMetadata(schema);
  if (metadata?.visibility === "public") {
    return metadata.baseSchema ?? schema;
  }

  if (schema instanceof z.ZodObject) {
    const publicShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, value] of Object.entries(schema.shape)) {
      const publicFieldSchema = extractPublicConfigSchemaInternal(value as z.ZodTypeAny);
      if (publicFieldSchema) {
        publicShape[key] = publicFieldSchema;
      }
    }

    if (Object.keys(publicShape).length === 0) {
      return null;
    }

    return z.object(publicShape);
  }

  if (schema instanceof z.ZodArray) {
    const publicElementSchema = extractPublicConfigSchemaInternal(schema.element as z.ZodTypeAny);
    if (!publicElementSchema) {
      return null;
    }

    return z.array(publicElementSchema);
  }

  return null;
}

export function redacted<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return addConfigSchemaMetadata(
    schema.transform((value): Redacted<z.output<TSchema>> => new Redacted(value)),
    {
      visibility: "redacted",
      baseSchema: schema,
    },
  );
}

export function publicValue<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return addConfigSchemaMetadata(
    schema.transform(
      (value): PublicConfigValue<z.output<TSchema>> =>
        value as PublicConfigValue<z.output<TSchema>>,
    ),
    {
      visibility: "public",
      baseSchema: schema,
    },
  );
}

export function getConfigVisibility(schema: z.ZodTypeAny): ConfigVisibility | null {
  return getConfigSchemaMetadata(schema)?.visibility ?? null;
}

export function parseAppConfig<TSchema extends z.ZodTypeAny>(schema: TSchema, rawConfig?: string) {
  return schema.parse(parseRawAppConfig(rawConfig));
}

export function extractPublicConfigSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
): z.ZodType<PublicAppConfig<z.output<TSchema>>> {
  const publicSchema = extractPublicConfigSchemaInternal(schema);
  if (publicSchema) {
    return publicSchema as z.ZodType<PublicAppConfig<z.output<TSchema>>>;
  }

  if (schema instanceof z.ZodObject) {
    return z.object({}) as unknown as z.ZodType<PublicAppConfig<z.output<TSchema>>>;
  }

  throw new Error("Schema does not contain any public config fields.");
}

export function getPublicConfig<TSchema extends z.ZodTypeAny>(
  value: z.output<TSchema>,
  schema: TSchema,
): PublicAppConfig<z.output<TSchema>> {
  return extractPublicConfigSchema(schema).parse(value);
}

function getBaseConfigEnvKey(prefix: string) {
  if (!prefix.endsWith("_")) {
    throw new Error(`Config env prefix must end with "_": ${prefix}`);
  }

  const baseKey = prefix.slice(0, -1);
  if (baseKey.length === 0) {
    throw new Error("Config env prefix must include a base key before the trailing underscore.");
  }

  return baseKey;
}

function formatEnvSegment(segment: string) {
  return segment.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function formatEnvOverrideKey(prefix: string, path: AppConfigPath) {
  if (path.length === 0) {
    return getBaseConfigEnvKey(prefix);
  }

  return `${prefix}${path.map(formatEnvSegment).join(ENV_PATH_SEPARATOR)}`;
}

function formatConfigPath(path: AppConfigPath) {
  return path.join(".");
}

function unwrapConfigSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;

  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = current.unwrap() as z.ZodTypeAny;
  }

  return current;
}

function assertKnownConfigOverrideKeys(options: {
  configSchema: z.ZodTypeAny;
  overrides: unknown;
  prefix: string;
  path?: AppConfigPath;
}) {
  const path = options.path ?? [];
  if (!isPlainObject(options.overrides)) {
    return;
  }

  const configSchema = unwrapConfigSchema(options.configSchema);
  if (!(configSchema instanceof z.ZodObject)) {
    const configPath = formatConfigPath(path);
    throw new Error(
      `Config override "${configPath}" from env var "${formatEnvOverrideKey(
        options.prefix,
        path,
      )}" targets nested keys on a non-object config field.`,
    );
  }

  for (const [key, value] of Object.entries(options.overrides)) {
    const childPath = [...path, key];
    const childSchema = configSchema.shape[key] as z.ZodTypeAny | undefined;
    if (!childSchema) {
      throw new Error(
        `Unknown config key "${formatConfigPath(childPath)}" from env var "${formatEnvOverrideKey(
          options.prefix,
          childPath,
        )}". This env var is not consumed by the config schema.`,
      );
    }

    assertKnownConfigOverrideKeys({
      configSchema: childSchema,
      overrides: value,
      prefix: options.prefix,
      path: childPath,
    });
  }
}

export function unflattenEnv(prefix: string, env: AppConfigEnv) {
  const result: AppConfigObject = {};

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(prefix) || typeof rawValue !== "string") {
      continue;
    }

    const path = key
      .slice(prefix.length)
      .split(ENV_PATH_SEPARATOR)
      .map(normalizeEnvSegment)
      .filter((segment) => segment.length > 0);

    if (path.length === 0) {
      continue;
    }

    let target = result;
    for (const segment of path.slice(0, -1)) {
      const existing = target[segment];
      if (isPlainObject(existing)) {
        target = existing;
        continue;
      }

      const nested: AppConfigObject = {};
      target[segment] = nested;
      target = nested;
    }

    const lastSegment = path.at(-1);
    if (!lastSegment) {
      continue;
    }

    target[lastSegment] = parseEnvOverrideValue(rawValue);
  }

  return result;
}

export function deepMerge(base: unknown, overrides: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides;
  }

  const merged: AppConfigObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(overrideValue)
        ? deepMerge(baseValue, overrideValue)
        : overrideValue;
  }

  return merged;
}

function pickConfigEnv(options: { env: AppConfigEnv; prefix: string }): Record<string, string> {
  const baseKey = getBaseConfigEnvKey(options.prefix);
  const configEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(options.env)) {
    if ((key === baseKey || key.startsWith(options.prefix)) && typeof value === "string") {
      configEnv[key] = value;
    }
  }

  return configEnv;
}

export function pickAppConfigEnv(env: AppConfigEnv): Record<string, string> {
  return pickConfigEnv({
    env,
    prefix: APP_CONFIG_ENV_PREFIX,
  });
}

export interface ParseAppConfigFromEnvOptions<TSchema extends z.ZodTypeAny> {
  configSchema: TSchema;
  prefix: string;
  env: AppConfigEnv;
}

/**
 * Parse app runtime config from environment variables.
 *
 * The env key immediately before `prefix` provides the base JSON blob
 * (`APP_CONFIG` for the `APP_CONFIG_` prefix). Nested env vars under `prefix`
 * are then unflattened and merged on top, for example:
 *
 * - `APP_CONFIG_LOGS__STDOUT_FORMAT=raw` -> `logs.stdoutFormat`
 * - `APP_CONFIG_POSTHOG='{"apiKey":"phc_xxx"}'` -> `posthog`
 *
 * Prefixed overrides are validated against `configSchema` before the final
 * merge so typos fail early during bootstrap and in runtime entrypoints,
 * instead of being silently ignored.
 */
export function parseAppConfigFromEnv<TSchema extends z.ZodTypeAny>({
  configSchema,
  prefix,
  env,
}: ParseAppConfigFromEnvOptions<TSchema>) {
  const baseKey = getBaseConfigEnvKey(prefix);
  const configEnv = pickConfigEnv({ env, prefix });
  const baseConfig = parseRawAppConfig(configEnv[baseKey], baseKey);
  const overrides = unflattenEnv(prefix, configEnv);

  assertKnownConfigOverrideKeys({
    configSchema,
    overrides,
    prefix,
  });

  return configSchema.parse(deepMerge(baseConfig, overrides));
}
