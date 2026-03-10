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
 * Cached drizzle instance for local dev / miniflare — reused across requests
 * to avoid leaking connections in long-lived processes.
 */
let cachedDevDb: NodePgDatabase<typeof schema> | undefined;

/**
 * Returns a drizzle DB instance.
 *
 * - **Production (real Hyperdrive):** Creates a new pg.Client per call.
 *   Cloudflare does NOT support reusing DB drivers across requests — each
 *   Hyperdrive proxy socket is per-request. Caching would use stale sockets.
 *   @see https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
 *
 * - **Local dev / miniflare:** Uses a cached pg.Pool to avoid leaking
 *   connections. Miniflare simulates Hyperdrive by passing DATABASE_URL
 *   through as connectionString, so we detect this by comparing the two.
 */
export async function getDb() {
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
    | { connectionString: string }
    | undefined;

  // Real Hyperdrive rewrites connectionString to a per-request proxy socket,
  // so it will differ from the origin DATABASE_URL. In miniflare the simulated
  // Hyperdrive just passes DATABASE_URL through unchanged.
  const isRealHyperdrive =
    hyperdrive && hyperdrive.connectionString !== env.DATABASE_URL;

  if (isRealHyperdrive) {
    // Production: per-request Client, Hyperdrive pools server-side
    return withRetry(async () => {
      const client = new Client({ connectionString: hyperdrive.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // Local dev / miniflare: cached Pool
  if (!cachedDevDb) {
    const connectionString = hyperdrive?.connectionString ?? env.DATABASE_URL;
    const pool = new Pool({ connectionString, max: 3 });
    cachedDevDb = drizzle({ client: pool, schema, casing: "snake_case" });
  }
  return cachedDevDb;
}

/** Accepts any env-like object with DATABASE_URL (used by DurableObjects). */
export async function getDbWithEnv(envParam: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  const isRealHyperdrive =
    envParam.HYPERDRIVE &&
    envParam.HYPERDRIVE.connectionString !== envParam.DATABASE_URL;

  if (isRealHyperdrive) {
    // Per-request Client for real Hyperdrive
    return withRetry(async () => {
      const client = new Client({ connectionString: envParam.HYPERDRIVE!.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // No real Hyperdrive (miniflare or no binding) — Pool for stability
  const connectionString = envParam.HYPERDRIVE?.connectionString ?? envParam.DATABASE_URL;
  const pool = new Pool({ connectionString, max: 3 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type DB = Awaited<ReturnType<typeof getDb>>;
