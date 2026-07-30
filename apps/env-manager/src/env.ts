import { env as workerEnv } from "cloudflare:workers";
import type { EnvironmentDurableObject } from "./environment-durable-object.ts";

export interface Env {
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentDurableObject>;
  CLOUDFLARE_API_TOKEN: SecretsStoreSecret;
  APP_CONFIG_BASE_URL: string;
  APP_CONFIG_ITERATE_AUTH__ISSUER: string;
  APP_CONFIG_ITERATE_AUTH__RESOURCE: string;
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID: string;
  APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: string;
  APP_CONFIG_ITERATE_AUTH__JWKS: string;
}

export const Env = workerEnv as unknown as Env;
