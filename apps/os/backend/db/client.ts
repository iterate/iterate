import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { env } from "../../env.ts";
import * as schema from "./schema.ts";

neonConfig.webSocketConstructor = WebSocket;
neonConfig.pipelineConnect = false;
neonConfig.useSecureWebSocket = !env.DATABASE_URL?.includes("localhost");
neonConfig.wsProxy = (host, port) =>
  host === "localhost"
    ? `localhost:4444/v2?address=${host}:${port}`
    : `${host}/v2?address=${host}:${port}`;

const pg = () => new Pool({ connectionString: env.DATABASE_URL });

export const getDb = () => drizzle(pg(), { schema, casing: "snake_case" });

export type DB = ReturnType<typeof getDb>;

export * as schema from "./schema.ts";
