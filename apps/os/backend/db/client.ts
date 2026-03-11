import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
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

const createPool = (databaseUrl: string) => new Pool({ connectionString: databaseUrl, max: 3 });

// Explicit return type annotation: tsgo in CI mis-infers drizzle()'s overloaded
// return as a Promise (a known tsgo bug with complex overloads), causing type
// errors at callsites that pass getDb to functions expecting () => DBLike.
export type DB = NeonDatabase<typeof schema> & { $client: Pool };

export const getDb = (): DB =>
  drizzle({ client: createPool(env.DATABASE_URL), schema, casing: "snake_case" });

/** Accepts any env-like object with DATABASE_URL */
export const getDbWithEnv = (envParam: { DATABASE_URL: string }): DB => {
  return drizzle({ client: createPool(envParam.DATABASE_URL), schema, casing: "snake_case" });
};
