import type { Client } from "pg";
import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";

/**
 * Workers Analytics Engine binding for DB query timing.
 *
 * Data point schema:
 *   indexes: [request_path]  — sampling key; high-cardinality paths are downsampled
 *   blobs:   [query_prefix, status, source]
 *     blob1: first 80 chars of the SQL query (for grouping without leaking params)
 *     blob2: "ok" | "error"
 *     blob3: "hyperdrive" | "pool" — which transport was used
 *   doubles: [duration_ms]
 *     double1: wall-clock time of the query in milliseconds
 *
 * Queryable via the WAE SQL API as `SELECT ... FROM DB_QUERY_TIMING`.
 */

type AnalyticsEngineBinding = {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
};

/** Extract the first SQL keyword + table for grouping (e.g. "SELECT FROM user"). */
function queryPrefix(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * Get the current request path from the env context.
 * Falls back to "unknown" if not in a request context.
 */
function getRequestPath(): string {
  // Hono stores the path on the worker env via contextStorage; we can't
  // import it here without coupling to Hono. Use a simple "unknown" fallback.
  return "unknown";
}

/**
 * Wraps a pg.Client so every `query()` call writes a timing data point
 * to Workers Analytics Engine. The wrapper is zero-overhead when the
 * DB_QUERY_TIMING binding is absent (local dev).
 *
 * writeDataPoint() is synchronous and fire-and-forget — it does NOT
 * add latency to the query path.
 */
export function instrumentClient(client: Client, source: "hyperdrive" | "pool"): Client {
  const ae = (env as Record<string, unknown>).DB_QUERY_TIMING as
    | AnalyticsEngineBinding
    | undefined;

  if (!ae) return client;

  const originalQuery = client.query.bind(client);

  /** Extract SQL text from the various argument shapes pg.Client.query accepts. */
  function extractSql(args: unknown[]): string {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "text" in first) {
      return String((first as { text: unknown }).text);
    }
    return "";
  }

  function writePoint(sql: string, status: "ok" | "error", durationMs: number) {
    try {
      ae.writeDataPoint({
        indexes: [getRequestPath()],
        blobs: [queryPrefix(sql), status, source],
        doubles: [durationMs],
      });
    } catch (writeErr) {
      // Never let analytics failures affect query results
      logger.warn("Failed to write query timing data point", writeErr);
    }
  }

  // pg.Client.query supports both promise and callback overloads.
  // Drizzle only uses the promise path, but we handle both defensively
  // to avoid changing the return-type contract for callback callers.
  (client as Record<string, unknown>).query = (...args: unknown[]) => {
    const sql = extractSql(args);
    const lastArg = args[args.length - 1];
    const hasCallback = typeof lastArg === "function";

    const start = performance.now();

    if (hasCallback) {
      // Callback overload: wrap the callback to measure duration
      const cb = lastArg as (...cbArgs: unknown[]) => void;
      args[args.length - 1] = (...cbArgs: unknown[]) => {
        const durationMs = performance.now() - start;
        const status = cbArgs[0] ? "error" : "ok"; // first arg is error per Node convention
        writePoint(sql, status, durationMs);
        return cb(...cbArgs);
      };
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    }

    // Promise overload
    const result = (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
    return result.then(
      (val) => {
        writePoint(sql, "ok", performance.now() - start);
        return val;
      },
      (err) => {
        writePoint(sql, "error", performance.now() - start);
        throw err;
      },
    );
  };

  return client;
}
