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

/** Postgres SQLSTATE codes that indicate transient/retryable failures. */
const TRANSIENT_PG_CODES = new Set([
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "57P01", // admin_shutdown
  "53300", // too_many_connections
]);

/**
 * Determines if a query error is transient and safe to retry.
 * Covers Neon connection drops, WebSocket failures, and Postgres transient SQLSTATE codes.
 * Also walks the `cause` chain (e.g. DrizzleQueryError wrapping a DatabaseError).
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Check the error itself and any wrapped cause
  for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    const msg = current.message;

    // Neon/WebSocket connection errors (always in the message)
    if (msg.includes("Connection terminated")) return true;
    if (msg.includes("connection timeout")) return true;
    if (msg.includes("ECONNRESET")) return true;
    if (msg.includes("ECONNREFUSED")) return true;
    if (msg.includes("socket hang up")) return true;
    if (msg.includes("WebSocket")) return true;
    if (msg.includes("fetch failed")) return true;

    // Postgres SQLSTATE codes live on DatabaseError.code (from pg-protocol), not in the message
    const code = (current as { code?: string }).code;
    if (typeof code === "string" && TRANSIENT_PG_CODES.has(code)) return true;
  }

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
