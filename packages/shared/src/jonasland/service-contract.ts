/**
 * Lightweight module for service contract definitions.
 *
 * This file is deliberately kept free of heavy dependencies (no OpenTelemetry,
 * no Node built-ins, no evlog, no vite). `-contract` packages should only import
 * from `@iterate-com/shared` under `apps` or `jonasland` (see eslint
 * `contract-package-imports` allowlist).
 *
 * If you need to add something here, make sure it only depends on
 * `@orpc/contract` and `zod` — nothing else.
 */

import type { AnyContractRouter } from "@orpc/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas used by the standard service sub-router
// ---------------------------------------------------------------------------

export const ServiceHealthOutput = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
});

export const ServiceSqlInput = z.object({
  statement: z.string().min(1),
});

export const ServiceSqlResultHeader = z.object({
  name: z.string(),
  displayName: z.string(),
  originalType: z.string().nullable(),
  type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

export const ServiceSqlResult = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  headers: z.array(ServiceSqlResultHeader),
  stat: z.object({
    rowsAffected: z.number().int(),
    rowsRead: z.number().int().nullable(),
    rowsWritten: z.number().int().nullable(),
    queryDurationMs: z.number().int().nullable(),
  }),
  lastInsertRowid: z.number().int().optional(),
});

export const ServiceDebugOutput = z.object({
  pid: z.number().int().nonnegative(),
  ppid: z.number().int().nonnegative(),
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

export type ServiceSqlInput = z.infer<typeof ServiceSqlInput>;
export type ServiceSqlResult = z.infer<typeof ServiceSqlResult>;
export type ServiceDebugOutput = z.infer<typeof ServiceDebugOutput>;

export interface SqlResultSet {
  columns: string[];
  columnTypes: Array<string | null>;
  rows: unknown[][];
  rowsAffected?: number;
  lastInsertRowid?: number | bigint | null;
}

// ---------------------------------------------------------------------------
// Service manifest types
// ---------------------------------------------------------------------------

export interface ServiceManifestLike<TContract extends AnyContractRouter = AnyContractRouter> {
  slug: string;
  port: number;
  orpcContract: TContract;
}

export interface ServiceManifestWithEntryPoint<
  TContract extends AnyContractRouter = AnyContractRouter,
> extends ServiceManifestLike<TContract> {
  serverEntryPoint: string;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Standard service sub-router contract builder
// ---------------------------------------------------------------------------

export function createServiceSubRouterContract(options?: {
  tag?: string;
  healthSummary?: string;
  sqlSummary?: string;
  debugSummary?: string;
}) {
  const tag = options?.tag ?? "service";

  return {
    service: {
      health: oc
        .route({
          method: "GET",
          path: "/__iterate/health",
          summary: options?.healthSummary ?? "Service health metadata",
          tags: [tag],
        })
        .input(z.object({}).optional().default({}))
        .output(ServiceHealthOutput),

      sql: oc
        .route({
          method: "POST",
          path: "/__iterate/sql",
          summary: options?.sqlSummary ?? "Execute SQL against service database",
          tags: [tag],
        })
        .input(ServiceSqlInput)
        .output(ServiceSqlResult),

      debug: oc
        .route({
          method: "GET",
          path: "/__iterate/debug",
          summary: options?.debugSummary ?? "Service runtime debug details",
          tags: [tag],
        })
        .input(z.object({}).optional().default({}))
        .output(ServiceDebugOutput),
    },
  } as const;
}
