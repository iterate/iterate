import { os } from "ai-engineer-workshop";
import { z } from "zod";

export const handler = os
  .input(
    z.object({
      streamPatternSuffix: z.string().default("/**"),
      banana: z.string(),
    }),
  )
  .handler(async ({ input }) => {
    input.b;
    return [input.pathPrefix, input.streamPatternSuffix, input.bogus];
  });
