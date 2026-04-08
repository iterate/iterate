import { os, runIfMain } from "ai-engineer-workshop";
import { z } from "zod";

export const handler = os
  .input(
    z.object({
      banana: z.string().default("banana"),
      count: z.number().default(2),
    }),
  )
  .handler(async ({ input }) => {
    return {
      pathPrefix: input.pathPrefix,
      logLevel: input.logLevel,
      banana: input.banana,
      count: input.count,
    };
  });

runIfMain(import.meta.url, handler);
