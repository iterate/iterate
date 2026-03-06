import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import * as schema from "./schema.ts";

// ---------------------------------------------------------------------------
// Transient error detection & retry logic
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

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
 * Covers connection drops, TCP resets, and Postgres transient SQLSTATE codes.
 * Also walks the `cause` chain (e.g. DrizzleQueryError wrapping a DatabaseError).
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  for (
    let current: unknown = err;
    current instanceof Error;
    current = (current as { cause?: unknown }).cause
  ) {
    const msg = current.message;

    if (msg.includes("Connection terminated")) return true;
    if (msg.includes("connection timeout")) return true;
    if (msg.includes("ECONNRESET")) return true;
    if (msg.includes("ECONNREFUSED")) return true;
    if (msg.includes("socket hang up")) return true;
    if (msg.includes("fetch failed")) return true;

    const code = (current as { code?: string }).code;
    if (typeof code === "string" && TRANSIENT_PG_CODES.has(code)) return true;
  }

  return false;
}

/** Retry-aware wrapper around an async function. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
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

// ---------------------------------------------------------------------------
// Retry Pool wrapper — intercepts queries to add transient error retries
// ---------------------------------------------------------------------------

/**
 * pg Pool with automatic retry on transient failures.
 */
class RetryPool extends Pool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pool.query has many overloads
  override async query(...args: any[]): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- super.query typing mismatch
    return withRetry(() => (super.query as any)(...args));
  }
}

// ---------------------------------------------------------------------------
// DB client factories
// ---------------------------------------------------------------------------

/**
 * Cached drizzle instance — reused across requests to avoid leaking memory
 * in long-lived processes (local dev via miniflare/workerd).
 *
 * In production Cloudflare Workers, the isolate gets cleaned up between
 * requests so caching is just an optimization.
 */
let cachedDb: NodePgDatabase<typeof schema> | undefined;

/**
 * Returns a drizzle DB instance backed by a pg.Pool.
 *
 * Uses Hyperdrive's connectionString in deployed environments (Hyperdrive
 * provides connection pooling + caching server-side). Falls back to
 * DATABASE_URL in local dev.
 *
 * We use pg.Pool (max: 3) rather than per-request Client because:
 * 1. In local dev (miniflare/workerd), Client-per-request leaks and OOMs.
 * 2. In production, Hyperdrive manages the upstream pool — a small client-side
 *    pool with max:3 per worker isolate is within CF's recommendations.
 *
 * @see https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
 */
export function getDb() {
  if (!cachedDb) {
    const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
      | { connectionString: string }
      | undefined;
    const connectionString = hyperdrive?.connectionString ?? env.DATABASE_URL;

    const pool = new RetryPool({ connectionString, max: 3 });
    cachedDb = drizzle({ client: pool, schema, casing: "snake_case" });
  }
  return cachedDb;
}

/** Accepts any env-like object with DATABASE_URL (used by DurableObjects). */
export function getDbWithEnv(envParam: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  const connectionString = envParam.HYPERDRIVE?.connectionString ?? envParam.DATABASE_URL;
  const pool = new RetryPool({ connectionString, max: 3 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type DB = ReturnType<typeof getDb>;
