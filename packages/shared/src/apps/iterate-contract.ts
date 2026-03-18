import { oc } from "@orpc/contract";
import { z } from "zod";

/**
 * Shared app-level operator/debug surface mounted under `/__iterate/*`.
 *
 * This namespace is intentionally PUBLIC right now. The goal is to give apps a
 * stable, recognizable set of debug/inspection endpoints that tooling and
 * humans can rely on across runtimes.
 *
 * The important split is:
 * - this file defines the shared CONTRACT and therefore the OpenAPI paths
 * - each app decides how to IMPLEMENT those procedures
 *
 * Capability differences are handled in the implementation rather than the
 * contract shape. For example, an app may expose `iterate.execSql` but answer
 * with `NOT_IMPLEMENTED` when raw SQL execution is not supported.
 */
export const IterateHealthOutputSchema = z.object({
  ok: z.literal(true),
  app: z.string(),
  version: z.string(),
});

export const IterateExecSqlInputSchema = z.object({
  statement: z.string().min(1),
});

export const IterateExecSqlResultHeaderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  originalType: z.string().nullable(),
  // SQLite/libsql column affinity codes used elsewhere in the repo too:
  // 1=text, 2=integer, 3=real, 4=blob.
  type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

export const IterateExecSqlOutputSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  headers: z.array(IterateExecSqlResultHeaderSchema),
  stat: z.object({
    rowsAffected: z.number().int(),
    rowsRead: z.number().int().nullable(),
    rowsWritten: z.number().int().nullable(),
    queryDurationMs: z.number().int().nullable(),
  }),
  lastInsertRowid: z.number().int().optional(),
});

export const IterateDebugOutputSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  uptimeSec: z.number().nonnegative(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  hostname: z.string(),
  cwd: z.string(),
  execPath: z.string(),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string().nullable()),
  memoryUsage: z.object({
    rss: z.number().int().nonnegative(),
    heapTotal: z.number().int().nonnegative(),
    heapUsed: z.number().int().nonnegative(),
    external: z.number().int().nonnegative(),
    arrayBuffers: z.number().int().nonnegative(),
  }),
});

export type IterateHealthOutput = z.infer<typeof IterateHealthOutputSchema>;
export type IterateExecSqlInput = z.infer<typeof IterateExecSqlInputSchema>;
export type IterateExecSqlOutput = z.infer<typeof IterateExecSqlOutputSchema>;
export type IterateDebugOutput = z.infer<typeof IterateDebugOutputSchema>;

export const iterateMetaRouterContract = {
  iterate: {
    health: oc
      .route({
        method: "GET",
        path: "/__iterate/health",
        summary: "Iterate health metadata",
        tags: ["iterate"],
      })
      .input(z.object({}).optional().default({}))
      .output(IterateHealthOutputSchema),
    debug: oc
      .route({
        method: "GET",
        path: "/__iterate/debug",
        summary: "Iterate runtime debug details",
        tags: ["iterate"],
      })
      .input(z.object({}).optional().default({}))
      .output(IterateDebugOutputSchema),
    execSql: oc
      .route({
        method: "POST",
        path: "/__iterate/sql",
        summary: "Execute raw SQL for debugging",
        tags: ["iterate"],
      })
      .input(IterateExecSqlInputSchema)
      .output(IterateExecSqlOutputSchema),
  },
} as const;
