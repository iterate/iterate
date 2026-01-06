import { z } from "zod/v4";
import { router, publicProcedure } from "../trpc.ts";

export const testingRouter = router({
  echo: publicProcedure.input(z.object({ message: z.string() })).query(async ({ input }) => {
    return { echo: input.message };
  }),

  healthCheck: publicProcedure.query(async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),
});
