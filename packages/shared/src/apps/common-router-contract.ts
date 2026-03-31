import { oc } from "@orpc/contract";
import { z } from "zod";
import { INTERNAL_OPENAPI_TAG } from "./openapi.ts";

const EmptyInput = z.object({}).optional().default({});

export const commonContract = oc.router({
  health: oc
    .route({ method: "GET", path: "/__common/health", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(
      z.object({
        ok: z.literal(true),
        app: z.string(),
        version: z.string(),
      }),
    ),
  publicConfig: oc
    .route({ method: "GET", path: "/__common/public-config", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(z.record(z.string(), z.unknown())),
  debug: oc
    .route({ method: "GET", path: "/__common/debug", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(z.record(z.string(), z.unknown())),
  execSql: oc
    .route({ method: "POST", path: "/__common/sql", tags: [INTERNAL_OPENAPI_TAG] })
    .input(
      z.object({
        statement: z.string().min(1),
      }),
    )
    .output(
      z.object({
        rows: z.array(z.record(z.string(), z.unknown())),
        columns: z.array(z.string()),
        stat: z.object({
          rowsAffected: z.number().int(),
          rowsRead: z.number().int().nullable(),
          rowsWritten: z.number().int().nullable(),
          queryDurationMs: z.number().int().nullable(),
        }),
        lastInsertRowid: z.number().int().optional(),
      }),
    ),
  refreshRegistry: oc
    .route({ method: "POST", path: "/__common/refresh-registry", tags: [INTERNAL_OPENAPI_TAG] })
    .input(
      z
        .object({
          registryBaseUrl: z.string().url().default("http://iterate.localhost"),
          baseUrl: z.string().url().optional(),
        })
        .optional()
        .default({ registryBaseUrl: "http://iterate.localhost" }),
    )
    .output(
      z.object({
        ok: z.literal(true),
      }),
    ),
});
