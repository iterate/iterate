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
// DB client factories
// ---------------------------------------------------------------------------

/**
 * Cached drizzle instance for local dev (no Hyperdrive). Reused across requests
 * to avoid creating new Pool + drizzle wrapper per call which leaks memory in
 * long-lived Node.js processes.
 */
let cachedDevDb: NodePgDatabase<typeof schema> | undefined;

/**
 * Creates a drizzle DB instance.
 *
 * Two strategies depending on the environment:
 *
 * **With Hyperdrive (production):** Creates a new pg.Client per request.
 * Hyperdrive manages connection pooling server-side, so a client-side Pool
 * would double-pool. Workers runtime cleans up isolates between requests.
 * @see https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/
 *
 * **Without Hyperdrive (local dev):** Uses a cached drizzle instance backed
 * by a shared pg.Pool to avoid leaking connections and memory.
 */
export async function getDb() {
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
    | { connectionString: string }
    | undefined;

  if (hyperdrive) {
    // Production: new Client per request, Hyperdrive pools server-side
    return withRetry(async () => {
      const client = new Client({ connectionString: hyperdrive.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // Local dev: cached drizzle instance with shared Pool
  if (!cachedDevDb) {
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
    cachedDevDb = drizzle({ client: pool, schema, casing: "snake_case" });
  }
  return cachedDevDb;
}

/**
 * Accepts any env-like object with DATABASE_URL (used by DurableObjects).
 * DurableObjects receive their own env bindings including HYPERDRIVE when available.
 */
export async function getDbWithEnv(envParam: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  if (envParam.HYPERDRIVE) {
    return withRetry(async () => {
      const client = new Client({ connectionString: envParam.HYPERDRIVE!.connectionString });
      await client.connect();
      return drizzle({ client, schema, casing: "snake_case" });
    });
  }

  // DurableObject without Hyperdrive: use Pool
  const pool = new Pool({ connectionString: envParam.DATABASE_URL, max: 3 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type DB = Awaited<ReturnType<typeof getDb>>;
