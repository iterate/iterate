import { parseAppConfigFromEnv, publicValue, redacted } from "@iterate-com/shared/config";
import { z } from "zod";

const JSONWebKeySet = z.object({
  keys: z.array(z.looseObject({ kty: z.string().trim().min(1) })),
});

export const AppConfig = z.object({
  baseUrl: publicValue(z.url()),
  iterateAuth: z.object({
    issuer: publicValue(z.url()),
    clientId: publicValue(z.string().trim().min(1)),
    clientSecret: redacted(z.string().trim().min(1)),
    jwks: JSONWebKeySet,
    resource: publicValue(z.url()),
  }),
});

export type AppConfig = z.output<typeof AppConfig>;

export function parseConfig(env: unknown): AppConfig {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: env as Record<string, unknown>,
  });
}
