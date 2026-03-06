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

  // pg.Client.query has multiple overloads — we patch the top-level entry
  // point which all overloads funnel through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as Record<string, unknown>).query = async (...args: unknown[]) => {
    const start = performance.now();
    let status: "ok" | "error" = "ok";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
    } catch (err) {
      status = "error";
      throw err;
    } finally {
      const durationMs = performance.now() - start;

      // Extract SQL text from the various argument shapes pg.Client.query accepts
      let sql = "";
      const first = args[0];
      if (typeof first === "string") {
        sql = first;
      } else if (first && typeof first === "object" && "text" in first) {
        sql = String((first as { text: unknown }).text);
      }

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
  };

  return client;
}
