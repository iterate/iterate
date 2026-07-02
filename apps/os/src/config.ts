import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { AppLogsConfig } from "@iterate-com/shared/evlog/types";
import { z } from "zod";

const JSONWebKeySet = z.object({
  keys: z.array(z.looseObject({ kty: z.string().trim().min(1) })),
});

/**
 * OS runtime config, parsed from the `APP_CONFIG` JSON blob plus `APP_CONFIG_*`
 * env overrides that Doppler/alchemy bake into the worker at deploy time
 * (e.g. `APP_CONFIG_BASE_URL`, `APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET`).
 *
 * `publicValue` fields are exposed to the browser via the public-config schema
 * below; `redacted` fields parse into `Redacted` wrappers that must be
 * explicitly unwrapped with `.exposeSecret()` and never serialize their value.
 */
export const AppConfig = z.object({
  baseUrl: publicValue(z.url().optional()),
  logs: AppLogsConfig.default({
    stdoutFormat: "pretty",
    filtering: { rules: [] },
  }),
  mcp: z
    .object({
      baseUrl: publicValue(z.url()),
    })
    .optional(),
  adminApiSecret: redacted(z.string().trim().min(1)).optional(),
  iterateAuth: z
    .object({
      issuer: publicValue(z.url().default("https://auth.iterate.com/api/auth")),
      clientId: publicValue(z.string().trim().min(1)),
      clientSecret: redacted(z.string().trim().min(1)),
      jwks: JSONWebKeySet.optional(),
      serviceToken: redacted(z.string().trim().min(1)).optional(),
      resource: publicValue(z.url()).optional(),
      emailOtpEnabled: publicValue(z.boolean().default(false)),
    })
    .optional(),
  openAiApiKey: redacted(z.string().trim().min(1)),
  cloudflare: z
    .object({
      apiToken: redacted(z.string().trim().min(1)).optional(),
    })
    .default({}),
  projectHostnameBases: publicValue(z.array(z.string().trim().min(1)).default([])),
  // Slack/Google integration config returns with the integrations domain
  // (itx-v4 migration Phase 12); the legacy branches were removed with it.
  typeIdPrefix: z
    .string()
    .trim()
    .regex(/^[a-z]+$/, "Type ID prefix must contain lowercase letters only")
    .default("os"),
  posthog: z
    .object({
      apiKey: publicValue(z.string().trim().min(1)),
    })
    .optional(),
});

export type AppConfig = z.output<typeof AppConfig>;

/**
 * Parse OS config from a worker or durable object `env` (the `cloudflare:workers`
 * import, `this.env`, an `ExecutionContext`'s bindings — all `APP_CONFIG_*`
 * carriers). Accepts `unknown` so callers don't need a cast at every site.
 */
export function parseConfig(env: unknown): AppConfig {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
}
