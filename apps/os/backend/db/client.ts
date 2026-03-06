import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
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
function isTransientError(err: unknown): boolean {
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
// DB client factories
// ---------------------------------------------------------------------------

/**
 * Cached drizzle instance for local dev — reused across requests to avoid
 * leaking Pool connections in long-lived miniflare/workerd processes.
 *
 * NOT used in production with Hyperdrive — Hyperdrive's connectionString
 * points to a per-request local proxy socket that is garbage-collected after
 * the request completes, so we must create a fresh Client per invocation.
 */
let cachedDevDb: NodePgDatabase<typeof schema> | undefined;

/**
 * Returns a drizzle DB instance.
 *
 * - **Production (Hyperdrive):** Creates a new pg.Client per call. Cloudflare
 *   Hyperdrive manages connection pooling server-side; client creation is fast
 *   because it connects to a local proxy socket. Caching the client/pool would
 *   cause stale connections since the proxy socket is per-request.
 *   @see https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
 *
 * - **Local dev:** Uses a cached pg.Pool to avoid leaking connections. The Pool
 *   is safe to reuse because DATABASE_URL is stable across requests.
 */
export async function getDb() {
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
    | { connectionString: string }
    | undefined;

  if (hyperdrive) {
    // Production: per-request Client, Hyperdrive pools server-side
    return withRetry(async () => {
      const client = new Client({ connectionString: hyperdrive.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // Local dev: cached Pool
  if (!cachedDevDb) {
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
    cachedDevDb = drizzle({ client: pool, schema, casing: "snake_case" });
  }
  return cachedDevDb;
}

/** Accepts any env-like object with DATABASE_URL (used by DurableObjects). */
export async function getDbWithEnv(envParam: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  const connectionString = envParam.HYPERDRIVE?.connectionString ?? envParam.DATABASE_URL;

  if (envParam.HYPERDRIVE) {
    // Per-request Client for Hyperdrive
    return withRetry(async () => {
      const client = new Client({ connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // No Hyperdrive — Pool for stability
  const pool = new Pool({ connectionString, max: 3 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type DB = Awaited<ReturnType<typeof getDb>>;
