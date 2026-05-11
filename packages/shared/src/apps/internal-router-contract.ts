import { oc } from "@orpc/contract";
import { z } from "zod";
import { INTERNAL_OPENAPI_TAG } from "./openapi.ts";

const EmptyInput = z.object({}).optional().default({});

export const internalContract = oc.router({
  health: oc
    .route({ method: "GET", path: "/__internal/health", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(
      z.object({
        ok: z.literal(true),
        app: z.string(),
        version: z.string(),
      }),
    ),
  publicConfig: oc
    .route({ method: "GET", path: "/__internal/public-config", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(z.record(z.string(), z.unknown())),
  debug: oc
    .route({ method: "GET", path: "/__internal/debug", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(z.record(z.string(), z.unknown())),
  trpcCliProcedures: oc
    .route({
      method: "GET",
      path: "/__internal/trpc-cli-procedures",
      tags: [INTERNAL_OPENAPI_TAG],
    })
    .input(EmptyInput)
    .output(
      z.object({
        procedures: z.array(z.unknown()),
      }),
    ),
  refreshRegistry: oc
    .route({ method: "POST", path: "/__internal/refresh-registry", tags: [INTERNAL_OPENAPI_TAG] })
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
