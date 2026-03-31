import { oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

export const CodemodeRunnerKind = z.enum(["legacy", "deterministic-v2"]);
export type CodemodeRunnerKind = z.infer<typeof CodemodeRunnerKind>;

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
      }),
    )
    .output(CodemodeRun),
  ctxTypeDefinition: oc
    .route({
      method: "GET",
      path: "/ctx-type-definition",
      summary: "Return the full TypeScript definition for the injected ctx interface",
      tags: ["codemode"],
    })
    .input(z.strictObject({}).optional().default({}))
    .output(z.string()),
});

export type CodemodeRun = z.infer<typeof CodemodeRun>;
