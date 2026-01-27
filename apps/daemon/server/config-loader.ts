import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

export interface IterateConfig {
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>;
}

let cachedConfig: IterateConfig | null = null;

/**
 * Load the iterate config from ITERATE_CONFIG_PATH (defaults to cwd).
 * Returns null if no config found or loading fails.
 * Config is cached after first successful load.
 *
 * Auto-builds the config by running `pnpm build` in the config directory.
 */
export async function loadConfig(): Promise<IterateConfig | null> {
  if (cachedConfig) return cachedConfig;

  // Default to current working directory
  const configPath = process.env.ITERATE_CONFIG_PATH || process.cwd();

  // Check if iterate.config.ts exists
  const configSource = `${configPath}/iterate.config.ts`;
  if (!existsSync(configSource)) {
    console.log("[config-loader] No iterate.config.ts found, skipping");
    return null;
  }

  // Auto-build the config
  console.log("[config-loader] Building config...");
  try {
    execSync("pnpm build", { cwd: configPath, stdio: "inherit" });
  } catch (err) {
    console.error("[config-loader] Build failed:", err);
    return null;
  }

  const bundlePath = `${configPath}/dist/index.js`;
  if (!existsSync(bundlePath)) {
    console.error(`[config-loader] Bundle not found after build: ${bundlePath}`);
    return null;
  }

  try {
    const configUrl = `file://${bundlePath}`;
    const module = await import(configUrl);

    if (typeof module.default?.fetch !== "function") {
      console.error("[config-loader] Config must export { fetch: Function }");
      return null;
    }

    cachedConfig = module.default as IterateConfig;
    console.log(`[config-loader] Loaded config from ${configPath}`);
    return cachedConfig;
  } catch (err) {
    console.error("[config-loader] Failed to load config:", err);
    return null;
  }
}

/**
 * Clear cached config (useful for testing or hot reload scenarios)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
