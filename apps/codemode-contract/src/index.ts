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

export const CodemodeRun = z.object({
  id: z.string(),
  runnerKind: CodemodeRunnerKind,
  code: z.string(),
  result: z.string(),
  logs: z.array(z.string()),
  error: z.string().nullable(),
});

export const codemodeContract = oc.router({
  common: commonContract,
  runV2: oc
    .route({
      method: "POST",
      path: "/run/v2",
      summary: "Execute a deterministic codemode function with typed API context",
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
