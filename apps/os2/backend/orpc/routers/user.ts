import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { protectedProcedure } from "../orpc.ts";
import { user, organizationUserMembership } from "../../db/schema.ts";

export const userRouter = {
  me: protectedProcedure.handler(async ({ context }) => {
    return context.user;
  }),

  myOrganizations: protectedProcedure.handler(async ({ context }) => {
    const memberships = await context.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, context.user.id),
      with: {
        organization: {
          with: {
            projects: true,
          },
        },
      },
    });

    return memberships.map((m) => ({
      ...m.organization,
      role: m.role,
    }));
  }),

  updateSettings: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        image: z.string().url().optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      const [updated] = await context.db
        .update(user)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.image && { image: input.image }),
        })
        .where(eq(user.id, context.user.id))
        .returning();

      return updated;
    }),
};
