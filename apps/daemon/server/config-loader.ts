/**
 * Config Loader
 *
 * Dynamically loads iterate.config.ts from CWD using tsx runtime.
 * Falls back to default config from repo-templates if file not found.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IterateConfig } from "../config/index.ts";

const CONFIG_FILENAME = "iterate.config.ts";

// Cached config singleton
let loadedConfig: IterateConfig | null = null;
let loadedConfigPath: string | null = null;

/**
 * Get the path to the default config in repo-templates.
 * Uses import.meta.url to find the monorepo root.
 */
function getDefaultConfigPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // Navigate from apps/daemon/server to repo root (3 levels up), then into repo-templates/default
  const repoRoot = path.resolve(currentDir, "..", "..", "..");
  return path.join(repoRoot, "repo-templates", "default", CONFIG_FILENAME);
}

/**
 * Load iterate.config.ts from the specified directory.
 * Uses tsx runtime for TypeScript execution.
 * Falls back to default config from repo-templates if not found.
 * Caches the result for subsequent calls.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  options?: { forceReload?: boolean },
): Promise<IterateConfig> {
  const forceReload = options?.forceReload ?? false;
  const configPath = path.join(cwd, CONFIG_FILENAME);

  if (!forceReload && loadedConfig !== null && loadedConfigPath === configPath) {
    return loadedConfig;
  }

  if (fs.existsSync(configPath)) {
    try {
      console.log(`[config] Loading config from ${configPath}`);
      const fileUrl = pathToFileURL(configPath).href;
      const module = await import(fileUrl);
      if (module.default === undefined) {
        throw new Error(`Config file ${configPath} does not have a default export`);
      }
      loadedConfig = module.default as IterateConfig;
      loadedConfigPath = configPath;
      console.log(`[config] Loaded config:`, loadedConfig);
      return loadedConfig;
    } catch (error) {
      console.error(`[config] Failed to load ${configPath}:`, error);
      console.log(`[config] Falling back to default config`);
    }
  } else {
    console.log(`[config] No ${CONFIG_FILENAME} found at ${configPath}`);
  }

  // Fall back to default config from repo-templates
  const defaultConfigPath = getDefaultConfigPath();
  if (fs.existsSync(defaultConfigPath)) {
    try {
      console.log(`[config] Loading default config from ${defaultConfigPath}`);
      const fileUrl = pathToFileURL(defaultConfigPath).href;
      const module = await import(fileUrl);
      if (module.default === undefined) {
        throw new Error(`Default config file ${defaultConfigPath} does not have a default export`);
      }
      loadedConfig = module.default as IterateConfig;
      loadedConfigPath = defaultConfigPath;
      console.log(`[config] Loaded default config:`, loadedConfig);
      return loadedConfig;
    } catch (error) {
      console.error(`[config] Failed to load default config:`, error);
    }
  }

  // Ultimate fallback: empty config (uses defaults in consumers)
  console.log(`[config] Using empty config as fallback`);
  loadedConfig = {};
  loadedConfigPath = null;
  return loadedConfig;
}

/**
 * Get the currently loaded config.
 * Throws if config hasn't been loaded yet.
 */
export function getConfig(): IterateConfig {
  if (loadedConfig === null) {
    throw new Error("Config not loaded. Call loadConfig() first during server startup.");
  }
  return loadedConfig;
}
