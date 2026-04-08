import { call } from "@orpc/server";
import { os } from "ai-engineer-workshop";
import { z } from "zod";

const procedure = os
  .input(
    z.object({
      streamPatternSuffix: z.string().default("/**"),
      projectSlug: z.string().default("demo-project"),
    }),
  )
  .handler(async ({ context, input }) => ({
    hasLogger: typeof context.logger.info === "function",
    logLevel: input.logLevel,
    pathPrefix: input.pathPrefix,
    projectSlug: input.projectSlug,
    streamPatternSuffix: input.streamPatternSuffix,
  }));

const rawHandler = procedure["~orpc"].handler as unknown as (
  opts: Record<string, unknown>,
) => Promise<unknown>;

const rawResult = await rawHandler({
  input: {
    logLevel: "info",
    pathPrefix: "/proof",
  },
  context: {},
  path: [],
  procedure,
  errors: {},
}).catch((error: unknown) => ({
  error: error instanceof Error ? error.message : String(error),
}));

const calledResult = await call(procedure, {
  logLevel: "info",
  pathPrefix: "/proof",
});

console.log(
  JSON.stringify(
    {
      calledResult,
      rawResult,
    },
    null,
    2,
  ),
);
