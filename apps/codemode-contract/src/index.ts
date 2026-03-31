import { oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

export const CodemodeRun = z.object({
  id: z.string(),
  code: z.string(),
  result: z.string(),
});

export const codemodeContract = oc.router({
  common: commonContract,
  run: oc
    .route({
      method: "POST",
      path: "/run",
      summary: "Execute a code snippet in an isolated Cloudflare worker",
      tags: ["codemode"],
    })
    .input(
      z.object({
        code: z.string().trim().min(1, "Code is required"),
      }),
    )
    .output(CodemodeRun),
});

export type CodemodeRun = z.infer<typeof CodemodeRun>;
