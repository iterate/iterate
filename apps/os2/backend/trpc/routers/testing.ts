import { z } from "zod/v4";
import { router, publicProcedure } from "../trpc.ts";
import { env } from "../../../env.ts";

export const testingRouter = router({
  createServiceSession: publicProcedure
    .input(z.object({ serviceAuthToken: z.string() }))
    .mutation(async ({ input }) => {
      if (input.serviceAuthToken !== env.SERVICE_AUTH_TOKEN) {
        throw new Error("Invalid service auth token");
      }

      return { authenticated: true };
    }),

  healthCheck: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),
});
