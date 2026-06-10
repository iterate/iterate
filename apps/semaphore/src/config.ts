import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { AppLogsConfig } from "@iterate-com/shared/evlog/types";
import { z } from "zod";

/**
 * Semaphore runtime config, parsed from the `APP_CONFIG` JSON blob plus
 * `APP_CONFIG_*` env overrides that Doppler/alchemy bake into the worker.
 *
 * `publicValue` fields are exposed to the browser via the public-config schema;
 * `redacted` fields parse into `Redacted` wrappers that must be unwrapped with
 * `.exposeSecret()` and never serialize their value.
 */
export const AppConfig = z.object({
  logs: AppLogsConfig.default({ stdoutFormat: "pretty", filtering: { rules: [] } }),
  posthog: z.object({
    apiKey: publicValue(z.string().trim().min(1)),
  }),
  sharedApiSecret: redacted(z.string().trim().min(1)),
});
export type AppConfig = z.output<typeof AppConfig>;

/** Parse semaphore config from a worker env (the `cloudflare:workers` import). */
export function parseConfig(env: unknown): AppConfig {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
}
