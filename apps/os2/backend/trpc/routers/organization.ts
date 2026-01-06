import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, orgProtectedProcedure, orgAdminProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { generateSlugFromName } from "../../utils/slug.ts";

export const organizationRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = generateSlugFromName(input.name);

      const existing = await ctx.db.query.organization.findFirst({
        where: eq(schema.organization.slug, slug),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Organization with slug "${slug}" already exists`,
        });
      }

      const [organization] = await ctx.db
        .insert(schema.organization)
        .values({
          name: input.name,
          slug,
        })
        .returning();

      await ctx.db.insert(schema.organizationUserMembership).values({
        organizationId: organization.id,
        userId: ctx.user.id,
        role: "owner",
      });

      return organization;
    }),

  get: orgProtectedProcedure.query(async ({ ctx }) => {
    return ctx.organization;
  }),

  update: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(schema.organization)
        .set({
          name: input.name,
        })
        .where(eq(schema.organization.id, ctx.organization.id))
        .returning();
      return updated;
    }),

  getMembers: orgProtectedProcedure.query(async ({ ctx }) => {
    const members = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(schema.organizationUserMembership.organizationId, ctx.organization.id),
      with: {
        user: true,
      },
    });
    return members.map((m) => ({
      id: m.id,
      role: m.role,
      user: {
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
      },
    }));
  }),

  updateMemberRole: orgAdminProcedure
    .input(
      z.object({
        memberId: z.string(),
        role: z.enum(["member", "admin", "owner"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.id, input.memberId),
          eq(schema.organizationUserMembership.organizationId, ctx.organization.id),
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Member not found",
        });
      }

      if (membership.role === "owner" && input.role !== "owner") {
        const ownerCount = await ctx.db.query.organizationUserMembership.findMany({
          where: and(
            eq(schema.organizationUserMembership.organizationId, ctx.organization.id),
            eq(schema.organizationUserMembership.role, "owner"),
          ),
        });

        if (ownerCount.length <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot demote the last owner",
          });
        }
      }

      const [updated] = await ctx.db
        .update(schema.organizationUserMembership)
        .set({ role: input.role })
        .where(eq(schema.organizationUserMembership.id, input.memberId))
        .returning();

      return updated;
    }),

  removeMember: orgAdminProcedure
    .input(
      z.object({
        memberId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.id, input.memberId),
          eq(schema.organizationUserMembership.organizationId, ctx.organization.id),
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Member not found",
        });
      }

      if (membership.role === "owner") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot remove an owner",
        });
      }

      await ctx.db
        .delete(schema.organizationUserMembership)
        .where(eq(schema.organizationUserMembership.id, input.memberId));

      return { success: true };
    }),
});
