import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import type { PoolConfig } from "@neondatabase/serverless";
import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import * as schema from "./schema.ts";

neonConfig.webSocketConstructor = WebSocket;
neonConfig.pipelineConnect = false;
neonConfig.useSecureWebSocket = !env.DATABASE_URL?.includes("localhost");
neonConfig.wsProxy = (host, port) =>
  host === "localhost"
    ? `localhost:${env.LOCAL_DOCKER_NEON_PROXY_PORT}/v2?address=${host}:${port}`
    : `${host}/v2?address=${host}:${port}`;

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 50;

/**
 * Determines if a query error is transient and safe to retry.
 * Covers Neon connection drops, WebSocket failures, and Postgres transient error codes.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;

  // Neon/WebSocket connection errors
  if (msg.includes("Connection terminated")) return true;
  if (msg.includes("connection timeout")) return true;
  if (msg.includes("ECONNRESET")) return true;
  if (msg.includes("ECONNREFUSED")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("WebSocket")) return true;
  if (msg.includes("fetch failed")) return true;

  // Postgres transient error codes (Class 08 = connection exceptions, 57P01 = admin shutdown, 53300 = too many connections)
  if (msg.includes("08006")) return true; // connection_failure
  if (msg.includes("08001")) return true; // sqlclient_unable_to_establish_sqlconnection
  if (msg.includes("08003")) return true; // connection_does_not_exist
  if (msg.includes("57P01")) return true; // admin_shutdown
  if (msg.includes("53300")) return true; // too_many_connections

  return false;
}

/**
 * Pool subclass that retries transient query failures with exponential backoff.
 * Neon's serverless driver has no built-in retry support, so we add it at the Pool level
 * since all drizzle queries flow through `pool.query()`.
 */
class RetryPool extends Pool {
  // Override query to add retry logic. Drizzle calls query(string, params) and query(config, params).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pool.query has many overloads; matching them all is impractical
  async query(...args: any[]): Promise<any> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding variadic args to super
        return await (super.query as any)(...args);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!isTransientError(err) || attempt === MAX_RETRIES) {
          throw lastError;
        }

        const delay = BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          `Retrying transient DB error (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }
}

const createPool = (databaseUrl: string) =>
  new RetryPool({ connectionString: databaseUrl, max: 3 } as PoolConfig);

export const getDb = () =>
  drizzle({ client: createPool(env.DATABASE_URL), schema, casing: "snake_case" });

/** Accepts any env-like object with DATABASE_URL */
export const getDbWithEnv = (envParam: { DATABASE_URL: string }) => {
  return drizzle({ client: createPool(envParam.DATABASE_URL), schema, casing: "snake_case" });
};

export type DB = ReturnType<typeof getDb>;
