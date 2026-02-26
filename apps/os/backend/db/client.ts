import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { env } from "../../env.ts";
import * as schema from "./schema.ts";

neonConfig.webSocketConstructor = WebSocket;
neonConfig.pipelineConnect = false;
neonConfig.useSecureWebSocket = !env.DATABASE_URL?.includes("localhost");
neonConfig.wsProxy = (host, port) =>
  host === "localhost"
    ? `localhost:${env.LOCAL_DOCKER_NEON_PROXY_PORT}/v2?address=${host}:${port}`
    : `${host}/v2?address=${host}:${port}`;

const createPool = (databaseUrl: string) =>
  new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

/**
 * Module-level cached pool and drizzle instance, reused across requests
 * within the same CF Worker isolate. Avoids creating a new WebSocket
 * connection pool on every request, which causes connection storms and
 * intermittent DB failures.
 */
let cachedDb: ReturnType<typeof drizzle<typeof schema>> | null = null;
let cachedDbUrl: string | null = null;

export const getDb = () => {
  const url = env.DATABASE_URL;
  if (cachedDb && cachedDbUrl === url) return cachedDb;
  cachedDb = drizzle({ client: createPool(url), schema, casing: "snake_case" });
  cachedDbUrl = url;
  return cachedDb;
};

/** Accepts any env-like object with DATABASE_URL */
export const getDbWithEnv = (envParam: { DATABASE_URL: string }) => {
  return drizzle({ client: createPool(envParam.DATABASE_URL), schema, casing: "snake_case" });
};

export type DB = ReturnType<typeof getDb>;
