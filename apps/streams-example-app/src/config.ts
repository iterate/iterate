import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { z } from "zod";

/**
 * Playground runtime config, parsed from the `APP_CONFIG_*` env vars that
 * deploys bake into the worker (secrets via `wrangler deploy --secrets-file`,
 * env-shaped vars generated from the root envs.ts).
 */

/** A JSON Web Key Set as jose expects it (the auth issuer's keys, baked at deploy). */
const JSONWebKeySet = z.object({
  keys: z.array(z.looseObject({ kty: z.string().trim().min(1) })),
});

export const AppConfig = z.object({
  // Deployed envs get APP_CONFIG_BASE_URL as a generated var from the same
  // envs.ts entry that names the worker. Optional because local dev has no
  // deployed base URL.
  baseUrl: publicValue(z.url().optional()),
  // Relying-party config against the env's apps/auth deployment — the same
  // shape as apps/os and apps/semaphore. Optional so local dev stays the
  // auth-less playground; every DEPLOYED env requires it (deploy.ts enforces
  // the secrets), and when present the worker is admin-only.
  iterateAuth: z
    .object({
      issuer: publicValue(z.url().default("https://auth.iterate.com/api/auth")),
      clientId: publicValue(z.string().trim().min(1)),
      clientSecret: redacted(z.string().trim().min(1)),
      jwks: JSONWebKeySet.optional(),
      resource: publicValue(z.url()).optional(),
    })
    .optional(),
});
export type AppConfig = z.output<typeof AppConfig>;

/** Parse playground config from a worker env (the `cloudflare:workers` import). */
export function parseConfig(env: unknown): AppConfig {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
}
