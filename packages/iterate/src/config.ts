import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod/v4";

const XDG_CONFIG_PARENT = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
);

export const CONFIG_PATH = join(XDG_CONFIG_PARENT, "config.json");

/** Stored session (lives inside a config entry) */
export const Session = z.object({
  token: z.string().optional(),
  refreshToken: z.string().optional(),
  clientId: z.string().optional(),
  scope: z.string().optional(),
  tokenType: z.string().optional(),
  cookie: z.string().optional(),
  expiresAt: z.string().optional(),
});

export type StoredSession = z.infer<typeof Session>;

/** A named config — describes which server to talk to and how to authenticate. */
export const Config = z.object({
  defaultProject: z.string().optional(),
  osBaseUrl: z.string().optional().default("https://os.iterate.com"),
  authBaseUrl: z.string().optional().default("https://auth.iterate.com"),
  session: Session.optional(),
});

export type Config = z.infer<typeof Config>;

/** The config file on disk (~/.config/iterate/config.json) */
export const ConfigFile = z.object({
  configs: z.record(z.string(), Config).optional(),
  default: z.string().optional(),
  /** Maps absolute directory path to a config name */
  workspaces: z.record(z.string(), z.string()).optional(),
});

export type ConfigFile = z.infer<typeof ConfigFile>;

export const readConfigFile = (): ConfigFile => {
  if (!existsSync(CONFIG_PATH)) return {};
  const rawText = readFileSync(CONFIG_PATH, "utf8");
  try {
    return JSON.parse(rawText) as ConfigFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${detail}`);
  }
};

export const writeConfigFile = (configFile: ConfigFile): void => {
  const parsed = ConfigFile.safeParse(configFile);
  if (!parsed.success) {
    throw new Error(`Invalid config file: ${z.prettifyError(parsed.error)}`);
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed.data, null, 2)}\n`);
};

/**
 * Read and validate a single named config, applying schema defaults and
 * normalizing URLs. Missing or invalid configs are returned as an Error value
 * by default, or thrown when called with `{ throw: true }`.
 */
export function readConfig(name: string): Config | Error;
export function readConfig(name: string, options: { throw: true }): Config;
export function readConfig(name: string, options?: { throw: true }): Config | Error {
  const result = ((): Config | Error => {
    const raw = readConfigFile().configs?.[name];
    if (!raw) return new Error(`Config "${name}" not found in ${CONFIG_PATH}`);
    const parsed = Config.safeParse(raw);
    if (!parsed.success) {
      return new Error(
        `Invalid config "${name}" in ${CONFIG_PATH}:\n${z.prettifyError(parsed.error)}`,
      );
    }
    // Strip trailing slashes to avoid double-slash URLs downstream.
    parsed.data.osBaseUrl = parsed.data.osBaseUrl.replace(/\/+$/, "");
    parsed.data.authBaseUrl = parsed.data.authBaseUrl.replace(/\/+$/, "");
    return parsed.data;
  })();
  if (result instanceof Error && options?.throw) throw result;
  return result;
}

/**
 * Merge session fields into the named config's stored session. Extra
 * runtime-only keys on `session` are stripped by the schema on write.
 */
export const updateConfigSession = (configName: string, session: StoredSession): void => {
  const configFile = readConfigFile();
  const entry = configFile.configs?.[configName];
  if (!entry) throw new Error(`Config "${configName}" not found`);
  entry.session = { ...entry.session, ...session };
  writeConfigFile(configFile);
};

export const removeConfigSession = (configName: string): void => {
  const configFile = readConfigFile();
  const entry = configFile.configs?.[configName];
  if (!entry?.session) return;
  delete entry.session;
  writeConfigFile(configFile);
};
