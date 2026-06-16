import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Redacted from "effect/Redacted";
import { z } from "zod";
import { compileRawAppConfigFromEnv } from "../config.ts";
import { slugify } from "../slugify.ts";

const AlchemyEnv = z.object({
  ALCHEMY_LOCAL: z.stringbool().default(false),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
});

export type AlchemyBootstrap<TConfig = unknown> = {
  local: boolean;
  rawRuntimeConfig: Record<string, unknown>;
  runtimeConfig: TConfig;
  slug: string;
  stack: {
    providers: ReturnType<typeof Cloudflare.providers>;
    state: ReturnType<typeof Alchemy.localState> | ReturnType<typeof Cloudflare.state>;
  };
  stage: string;
  workerName: string;
};

/**
 * Build the shared deployment context for an Alchemy v2 stack.
 *
 * - Parses `ALCHEMY_*` env vars via zod
 * - Loads `APP_CONFIG` + `APP_CONFIG_*` overrides into a typed config object
 * - Selects v2 state/provider layers: local state for dev, Cloudflare state
 *   for preview/prod
 *
 * Use `ctx.stack` as the second argument to `Alchemy.Stack(...)`.
 *
 * ```ts
 * import { AppConfig } from "./src/config.ts";
 * const ctx = await initAlchemy("my-app", AppConfig, process.env);
 * export default Alchemy.Stack("my-app", ctx.stack, Effect.gen(function* () {
 *   // ... declare resources with yield* Cloudflare.Worker(...)
 * }));
 * ```
 */
export async function initAlchemy<TSchema extends z.ZodTypeAny>(
  // The slug names the alchemy scope and prefixes the worker name.
  slug: string,
  configSchema: TSchema,
  env: Record<string, string | undefined>,
): Promise<AlchemyBootstrap<z.output<TSchema>>> {
  const alchemyEnv = AlchemyEnv.parse(env);

  const rawRuntimeConfig = compileRawAppConfigFromEnv({
    configSchema,
    prefix: "APP_CONFIG_",
    env,
  }) as Record<string, unknown>;
  const runtimeConfig = configSchema.parse(rawRuntimeConfig) as z.output<TSchema>;

  const stage = alchemyEnv.ALCHEMY_STAGE;
  const workerName = slugify(`${slug}-${stage}`);

  return {
    local: alchemyEnv.ALCHEMY_LOCAL,
    slug,
    rawRuntimeConfig,
    runtimeConfig,
    stack: {
      providers: Cloudflare.providers(),
      state: alchemyEnv.ALCHEMY_LOCAL ? Alchemy.localState() : Cloudflare.state(),
    },
    stage,
    workerName,
  };
}

export function appConfigBinding(ctx: Pick<AlchemyBootstrap, "local" | "rawRuntimeConfig">) {
  const serialized = JSON.stringify(ctx.rawRuntimeConfig, null, 2);
  return ctx.local ? serialized : Redacted.make(serialized);
}
