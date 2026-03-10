import { drizzle } from "drizzle-orm/node-postgres";
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
 * Returns a drizzle DB instance.
 *
 * - **Hyperdrive (deployed workers):** Creates a per-request pg.Client.
 *   Cloudflare requires a fresh client per request — Hyperdrive manages
 *   connection pooling server-side. No client.end() needed; Hyperdrive
 *   auto-cleans when the request ends.
 *   @see https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
 *
 * - **Local dev / miniflare:** Creates a per-request pg.Pool (not cached).
 *   Matches the original Neon driver behavior on main. Pool manages its own
 *   connections and is GC'd when the request ends. Must NOT be cached in
 *   module scope — workerd does not allow I/O across request contexts.
 */
export async function getDb() {
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
    | { connectionString: string }
    | undefined;

  if (env.IS_HYPERDRIVE && hyperdrive) {
    return withRetry(async () => {
      const client = new Client({ connectionString: hyperdrive.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // Local dev / miniflare: per-request Pool, just like the original Neon driver on main.
  // idleTimeoutMillis explicit for clarity (10s is the pg default; 0 = disabled, not zero-delay).
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

/** Accepts any env-like object with DATABASE_URL (used by DurableObjects). */
export async function getDbWithEnv(envParam: {
  DATABASE_URL: string;
  IS_HYPERDRIVE?: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  if (envParam.IS_HYPERDRIVE && envParam.HYPERDRIVE) {
    return withRetry(async () => {
      const client = new Client({ connectionString: envParam.HYPERDRIVE!.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  const pool = new Pool({ connectionString: envParam.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type DB = Awaited<ReturnType<typeof getDb>>;
