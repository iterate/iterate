import { oc } from "@orpc/contract";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
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

export const CodemodeInlineOpenApiSource = z.object({
  type: z.literal("openapi-inline"),
  spec: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional(),
  namespace: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type CodemodeInlineOpenApiSource = z.infer<typeof CodemodeInlineOpenApiSource>;

export const CodemodeOrpcContractSource = z.object({
  type: z.literal("orpc-contract"),
  service: CodemodeContractSourceService,
});
export type CodemodeOrpcContractSource = z.infer<typeof CodemodeOrpcContractSource>;

export const CodemodeSource = z.discriminatedUnion("type", [
  CodemodeOpenApiSource,
  CodemodeInlineOpenApiSource,
  CodemodeOrpcContractSource,
]);
export type CodemodeSource = z.infer<typeof CodemodeSource>;

export const CodemodeCompiledScriptInput = z.object({
  type: z.literal("compiled-script"),
  script: z.string().trim().min(1, "Script is required"),
});
export type CodemodeCompiledScriptInput = z.infer<typeof CodemodeCompiledScriptInput>;

export const CodemodePackageProjectInput = z.object({
  type: z.literal("package-project"),
  entryPoint: z.string().trim().min(1, "Entry point is required"),
  files: z.record(z.string(), z.string()).superRefine((files, context) => {
    if (Object.keys(files).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one file is required",
      });
    }

    if (!Object.prototype.hasOwnProperty.call(files, "package.json")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "package.json is required for package-project inputs",
      });
    }
  }),
});
export type CodemodePackageProjectInput = z.infer<typeof CodemodePackageProjectInput>;

export const CodemodeInput = z.discriminatedUnion("type", [
  CodemodeCompiledScriptInput,
  CodemodePackageProjectInput,
]);
export type CodemodeInput = z.infer<typeof CodemodeInput>;

export const CodemodeSecretRecord = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CodemodeSecretRecord = z.infer<typeof CodemodeSecretRecord>;

export const CodemodeSecretDetail = CodemodeSecretRecord;
export type CodemodeSecretDetail = z.infer<typeof CodemodeSecretDetail>;

export const CodemodeRun = z.object({
  id: z.string(),
  runnerKind: CodemodeRunnerKind,
  input: CodemodeInput,
  sources: z.array(CodemodeSource),
  result: z.string(),
  error: z.string().nullable(),
});
export type CodemodeRun = z.infer<typeof CodemodeRun>;

export const CodemodeRunRecord = z.object({
  id: z.string(),
  runnerKind: CodemodeRunnerKind,
  input: CodemodeInput,
  codeSnippet: z.string(),
  sources: z.array(CodemodeSource),
  result: z.string(),
  logs: z.array(z.string()),
  error: z.string().nullable(),
});
export type CodemodeRunRecord = z.infer<typeof CodemodeRunRecord>;

export const CodemodeRunSummary = z.object({
  id: z.string(),
  codePreview: z.string(),
  resultPreview: z.string(),
});
export type CodemodeRunSummary = z.infer<typeof CodemodeRunSummary>;

export const codemodeContract = oc.router({
  __internal: internalContract,
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
        input: CodemodeInput,
        sources: z.array(CodemodeSource).optional().default([]),
      }),
    )
    .output(CodemodeRun),
  runs: oc.router({
    list: oc
      .route({
        method: "GET",
        path: "/runs",
        summary: "List codemode runs",
        tags: ["codemode"],
      })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      )
      .output(
        z.object({
          runs: z.array(CodemodeRunSummary),
          total: z.number().int().nonnegative(),
        }),
      ),
    find: oc
      .route({
        method: "GET",
        path: "/runs/{id}",
        summary: "Find a codemode run by id",
        tags: ["codemode"],
      })
      .input(
        z.object({
          id: z.string().trim().min(1),
        }),
      )
      .output(CodemodeRunRecord),
  }),
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
