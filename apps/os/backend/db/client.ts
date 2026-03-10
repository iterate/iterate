import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
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

/** Hidden key used to stash the underlying pg.Client on drizzle instances. */
const kPgClient = Symbol.for("pgClient");

/**
 * Returns a drizzle DB instance backed by a per-request pg.Client.
 *
 * Cloudflare does NOT support reusing DB drivers across requests — Hyperdrive
 * proxy sockets are per-request. We use the same per-request Client strategy
 * in local dev / miniflare for dev-prod parity.
 *
 * The underlying Client is stashed on the drizzle instance via a Symbol so
 * that `cleanupDb()` can close it without callers needing to manage it.
 *
 * @see https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
 */
export async function getDb() {
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
    | { connectionString: string }
    | undefined;
  const connectionString = hyperdrive?.connectionString ?? env.DATABASE_URL;

  return withRetry(async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const db = drizzle({ client, schema, casing: "snake_case" });
    (db as any)[kPgClient] = client;
    return db;
  });
}

/** Accepts any env-like object with DATABASE_URL (used by DurableObjects). */
export async function getDbWithEnv(envParam: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) {
  const connectionString = envParam.HYPERDRIVE?.connectionString ?? envParam.DATABASE_URL;

  return withRetry(async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const db = drizzle({ client, schema, casing: "snake_case" });
    (db as any)[kPgClient] = client;
    return db;
  });
}

/**
 * Closes the underlying pg.Client for a drizzle instance created by
 * `getDb()` / `getDbWithEnv()`. Safe to call on any DB — no-ops if there
 * is no stashed client (e.g. if backed by a Pool).
 */
export async function cleanupDb(db: DB): Promise<void> {
  const client = (db as any)[kPgClient] as Client | undefined;
  if (client) {
    try {
      await client.end();
    } catch {
      // Ignore errors during cleanup — connection may already be closed.
    }
  }
}

export type DB = Awaited<ReturnType<typeof getDb>>;
