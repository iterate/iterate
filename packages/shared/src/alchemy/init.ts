import alchemy, { type Scope } from "alchemy";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { z } from "zod";
import {
  compileRawAppConfigFromEnv,
  parseAppConfigFromEnv,
  type BaseAppConfig,
} from "../apps/config.ts";
import type { AppManifest } from "../apps/types.ts";
import { slugify } from "../slugify.ts";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
});

/**
 * Initialise an Alchemy app with standard env parsing, config loading, and
 * state store. This is the entry point for every Iterate app's `alchemy.run.ts`.
 *
 * - Parses `ALCHEMY_*` and `CLOUDFLARE_*` env vars via zod
 * - Loads `APP_CONFIG` + `APP_CONFIG_*` overrides into a typed config object
 *   (see `packages/shared/src/apps/config.ts` for the merge semantics)
 * - Selects state store: local SQLite for dev, Cloudflare KV for deploys
 *   (https://alchemy.run/guides/cloudflare-state-store/)
 *
 * Call `app.finalize()` after all resources have been declared.
 *
 * ```ts
 * import manifest, { AppConfig } from "./src/app.ts";
 * const ctx = await initAlchemy(manifest, AppConfig, process.env);
 * // ... declare resources ...
 * await ctx.app.finalize();
 * ```
 *
 * @see https://alchemy.run/getting-started/
 */
export async function initAlchemy<TSchema extends z.ZodTypeAny>(
  manifest: AppManifest,
  configSchema: TSchema,
  env: Record<string, string | undefined>,
) {
  const alchemyEnv = AlchemyEnv.parse(env);
  if (alchemyEnv.ALCHEMY_LOCAL) delete env.CI;

  const compiledAppConfig = parseAppConfigFromEnv({
    configSchema,
    prefix: "APP_CONFIG_",
    env,
  }) as BaseAppConfig & z.output<TSchema>;

  const rawAppConfig = compileRawAppConfigFromEnv({
    configSchema,
    prefix: "APP_CONFIG_",
    env,
  });

  const stateStore = (scope: Scope) =>
    scope.local
      ? new SQLiteStateStore(scope, { engine: "libsql" })
      : new CloudflareStateStore(scope);

  const app = await alchemy(manifest.slug, {
    stage: alchemyEnv.ALCHEMY_STAGE,
    local: alchemyEnv.ALCHEMY_LOCAL,
    password: alchemyEnv.ALCHEMY_PASSWORD,
    stateStore,
  });

  return {
    app,
    manifest,
    workerName: slugify(`${manifest.slug}-${app.stage}`),
    compiledAppConfig,
    rawAppConfig,
  };
}
