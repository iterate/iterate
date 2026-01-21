import { z } from "zod/v4";
import { eq, desc } from "drizzle-orm";
import { withProjectInput } from "../trpc.ts";
import * as schema from "../../db/schema.ts";

export const eventRouter = {
  list: withProjectInput({
    limit: z.number().int().min(1).max(100).default(50),
  }).handler(async ({ context, input }) => {
    const events = await context.db.query.event.findMany({
      where: eq(schema.event.projectId, context.project.id),
      orderBy: [desc(schema.event.createdAt)],
      limit: input.limit,
    });
    return events;
  }),
};
