import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { AppLogsConfig } from "@iterate-com/shared/evlog/types";
import { z } from "zod";

/**
 * Semaphore runtime config, parsed from the `APP_CONFIG_*` env vars that
 * deploys bake into the worker (secrets via `wrangler deploy --secrets-file`,
 * env-shaped vars generated from the root envs.ts).
 *
 * `publicValue` fields are exposed to the browser via the public-config schema;
 * `redacted` fields parse into `Redacted` wrappers that must be unwrapped with
 * `.exposeSecret()` and never serialize their value.
 */
export const AppConfig = z.object({
  // Deployed envs get APP_CONFIG_BASE_URL as a generated var from the same
  // envs.ts entry that produces the worker route (scripts/
  // generate-wrangler-config.ts), so runtime URL and route can never drift.
  // Optional because local dev has no deployed base URL.
  baseUrl: publicValue(z.url().optional()),
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
