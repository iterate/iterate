import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { env } from "../../env.ts";
import { isNonProd } from "../../env-client.ts";
import * as schema from "./schema.ts";

/**
 * In non-prod, route @neondatabase/serverless through the local neon proxy
 * (docker service `neon-proxy`) for WebSocket support.
 * Production targets Neon cloud which works out of the box.
 *
 * See https://github.com/TimoWilhelm/local-neon-http-proxy
 */
if (isNonProd && "LOCAL_DOCKER_NEON_PROXY_PORT" in env) {
  const proxyPort = String((env as Record<string, unknown>)["LOCAL_DOCKER_NEON_PROXY_PORT"] ?? "");
  if (proxyPort) {
    neonConfig.useSecureWebSocket = false;
    neonConfig.wsProxy = (host) => `${host}:${proxyPort}/v1`;
  }
}

export const getDb = () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  return drizzle({ client: pool, schema, casing: "snake_case" });
};

/** Accepts any env-like object with DATABASE_URL */
export const getDbWithEnv = (envParam: { DATABASE_URL: string }) => {
  const pool = new Pool({ connectionString: envParam.DATABASE_URL });
  return drizzle({ client: pool, schema, casing: "snake_case" });
};

export type DB = ReturnType<typeof getDb>;
