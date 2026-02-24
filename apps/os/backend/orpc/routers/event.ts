import { z } from "zod/v4";
import { eq, desc } from "drizzle-orm";
import { projectProtectedProcedure, ProjectInput } from "../procedures.ts";
import * as schema from "../../db/schema.ts";

export const eventRouter = {
  list: projectProtectedProcedure
    .input(
      z.object({
        ...ProjectInput.shape,
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const events = await ctx.db.query.event.findMany({
        where: eq(schema.event.projectId, ctx.project.id),
        orderBy: [desc(schema.event.createdAt)],
        limit: input.limit,
      });
      return events;
    }),
};
