import { oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

export const CodemodeRunnerKind = z.enum(["legacy", "deterministic-v2"]);
export type CodemodeRunnerKind = z.infer<typeof CodemodeRunnerKind>;

export const CodemodeContractSourceService = z.enum([
  "example",
  "events",
  "semaphore",
  "ingressProxy",
]);
export type CodemodeContractSourceService = z.infer<typeof CodemodeContractSourceService>;

export const CodemodeOpenApiSource = z.object({
  type: z.literal("openapi"),
  url: z.string().trim().url(),
  baseUrl: z.string().trim().url().optional(),
  namespace: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type CodemodeOpenApiSource = z.infer<typeof CodemodeOpenApiSource>;

export const CodemodeOrpcContractSource = z.object({
  type: z.literal("orpc-contract"),
  service: CodemodeContractSourceService,
});
export type CodemodeOrpcContractSource = z.infer<typeof CodemodeOrpcContractSource>;

export const CodemodeSource = z.discriminatedUnion("type", [
  CodemodeOpenApiSource,
  CodemodeOrpcContractSource,
]);
export type CodemodeSource = z.infer<typeof CodemodeSource>;

export const CodemodeSecretRecord = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CodemodeSecretRecord = z.infer<typeof CodemodeSecretRecord>;

export const CodemodeSecretDetail = CodemodeSecretRecord.extend({
  value: z.string(),
});
export type CodemodeSecretDetail = z.infer<typeof CodemodeSecretDetail>;

export const CodemodeRun = z.object({
  id: z.string(),
  runnerKind: CodemodeRunnerKind,
  code: z.string(),
  sources: z.array(CodemodeSource),
  result: z.string(),
  error: z.string().nullable(),
});

export const codemodeContract = oc.router({
  common: commonContract,
  secrets: oc.router({
    create: oc
      .route({
        method: "POST",
        path: "/secrets",
        summary: "Create a codemode secret",
        tags: ["codemode"],
      })
      .input(
        z.object({
          key: z.string().trim().min(1, "Secret key is required"),
          value: z.string().min(1, "Secret value is required"),
          description: z.string().trim().optional(),
        }),
      )
      .output(CodemodeSecretRecord),
    list: oc
      .route({
        method: "GET",
        path: "/secrets",
        summary: "List codemode secrets",
        tags: ["codemode"],
      })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      )
      .output(
        z.object({
          secrets: z.array(CodemodeSecretRecord),
          total: z.number().int().nonnegative(),
        }),
      ),
    find: oc
      .route({
        method: "GET",
        path: "/secrets/{id}",
        summary: "Find a codemode secret by id",
        tags: ["codemode"],
      })
      .input(
        z.object({
          id: z.string().trim().min(1),
        }),
      )
      .output(CodemodeSecretDetail),
    remove: oc
      .route({
        method: "DELETE",
        path: "/secrets/{id}",
        summary: "Delete a codemode secret",
        tags: ["codemode"],
      })
      .input(
        z.object({
          id: z.string().trim().min(1),
        }),
      )
      .output(
        z.object({
          ok: z.literal(true),
          id: z.string(),
          deleted: z.boolean(),
        }),
      ),
  }),
  runV2: oc
    .route({
      method: "POST",
      path: "/run/v2",
      summary: "Execute a codemode function with typed API context",
      tags: ["codemode"],
    })
    .input(
      z.object({
        code: z.string().trim().min(1, "Code is required"),
        sources: z.array(CodemodeSource).optional().default([]),
      }),
    )
    .output(CodemodeRun),
  ctxTypeDefinition: oc
    .route({
      method: "POST",
      path: "/ctx-type-definition",
      summary: "Return the full TypeScript definition for the injected ctx interface",
      tags: ["codemode"],
    })
    .input(
      z.object({
        sources: z.array(CodemodeSource).optional().default([]),
      }),
    )
    .output(z.string()),
});

export type CodemodeRun = z.infer<typeof CodemodeRun>;
