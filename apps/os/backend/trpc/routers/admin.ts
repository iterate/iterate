import { z } from "zod/v4";
import { and, eq, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc.ts";
import { schema } from "../../db/client.ts";
import { sendNotificationToIterateSlack } from "../../integrations/slack/slack-utils.ts";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not authorized to access this resource",
    });
  }
  return next({ ctx });
});

const findUserByEmail = adminProcedure
  .input(z.object({ email: z.string() }))
  .query(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
    });
    return user;
  });

const getEstateOwner = adminProcedure
  .input(z.object({ estateId: z.string() }))
  .query(async ({ ctx, input }) => {
    const estate = await ctx.db.query.estate.findFirst({
      where: eq(schema.estate.id, input.estateId),
    });

    if (!estate) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Estate not found",
      });
    }

    const ownerMembership = await ctx.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(schema.organizationUserMembership.organizationId, estate.organizationId),
        eq(schema.organizationUserMembership.role, "owner"),
      ),
      with: {
        user: true,
      },
    });

    if (!ownerMembership?.user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Estate owner not found",
      });
    }

    return {
      userId: ownerMembership.user.id,
      email: ownerMembership.user.email,
      name: ownerMembership.user.name,
    };
  });

const deleteUserByEmail = adminProcedure
  .input(z.object({ email: z.string().email() }))
  .mutation(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
    });

    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    // Find all organizations where the user is the owner
    const ownedOrganizations = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(schema.organizationUserMembership.userId, user.id),
      with: {
        organization: {
          with: {
            estates: true,
          },
        },
      },
    });

    const ownerOrganizations = ownedOrganizations.filter(
      (membership) => membership.role === "owner",
    );
    const deletedOrganizations: string[] = [];
    const deletedEstates: string[] = [];

    // Delete organizations the user owns; estates and related records will cascade
    for (const membership of ownerOrganizations) {
      const org = membership.organization;
      // Collect estate ids for return value before deletion cascades
      for (const e of org.estates) deletedEstates.push(e.id);
      await ctx.db.delete(schema.organization).where(eq(schema.organization.id, org.id));
      deletedOrganizations.push(org.id);
    }

    // Finally, delete the user; related rows (accounts, sessions, mappings, memberships, client info) will cascade
    await ctx.db.delete(schema.user).where(eq(schema.user.id, user.id));

    return {
      success: true,
      deletedUser: user.id,
      deletedOrganizations,
      deletedEstates,
    };
  });

export const adminRouter = router({
  findUserByEmail,
  getEstateOwner,
  deleteUserByEmail,
  impersonationInfo: protectedProcedure.query(async ({ ctx }) => {
    // || undefined means non-admins and non-impersonated users get `{}` from this endpoint, revealing no information
    // important because it's available to anyone signed in
    const impersonatedBy = ctx?.session?.session.impersonatedBy || undefined;
    const isAdmin = ctx?.user?.role === "admin" || undefined;
    return { impersonatedBy, isAdmin };
  }),
  sendSlackNotification: adminProcedure
    .input(
      z.object({
        message: z.string().min(1, "Message cannot be empty"),
        channel: z.string().min(1, "Channel cannot be empty"),
      }),
    )
    .mutation(async ({ input }) => {
      await sendNotificationToIterateSlack(input.message, input.channel);
      return { success: true };
    }),
  getSessionInfo: adminProcedure.query(async ({ ctx }) => {
    return {
      user: ctx.user,
      session: ctx.session,
    };
  }),
  listAllEstates: adminProcedure.query(async ({ ctx }) => {
    const estates = await ctx.db.query.estate.findMany({
      with: {
        organization: {
          with: {
            members: {
              where: eq(schema.organizationUserMembership.role, "owner"),
              with: {
                user: true,
              },
            },
          },
        },
      },
      orderBy: desc(schema.estate.updatedAt),
    });

    return estates.map((estate) => ({
      id: estate.id,
      name: estate.name,
      organizationId: estate.organizationId,
      organizationName: estate.organization.name,
      ownerEmail: estate.organization.members[0]?.user.email,
      ownerName: estate.organization.members[0]?.user.name,
      ownerId: estate.organization.members[0]?.user.id,
      connectedRepoId: estate.connectedRepoId,
      connectedRepoPath: estate.connectedRepoPath,
      connectedRepoRef: estate.connectedRepoRef,
      createdAt: estate.createdAt,
      updatedAt: estate.updatedAt,
    }));
  }),
  rebuildEstate: adminProcedure
    .input(z.object({ estateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { triggerEstateRebuild } = await import("./estate.ts");

      const estateData = await ctx.db.query.estate.findFirst({
        where: eq(schema.estate.id, input.estateId),
      });

      if (!estateData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Estate not found",
        });
      }

      if (!estateData.connectedRepoId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Estate has no connected repository",
        });
      }

      const result = await triggerEstateRebuild({
        db: ctx.db,
        env: ctx.env,
        estateId: input.estateId,
        commitHash: estateData.connectedRepoRef || "main",
        commitMessage: "Manual rebuild triggered by admin",
        isManual: true,
      });

      return { success: true, buildId: result.id };
    }),
  rebuildAllEstates: adminProcedure.mutation(async ({ ctx }) => {
    const { triggerEstateRebuild } = await import("./estate.ts");

    const estates = await ctx.db.query.estate.findMany({
      where: eq(schema.estate.connectedRepoId, schema.estate.connectedRepoId),
    });

    const results = [];

    for (const estate of estates) {
      if (!estate.connectedRepoId) {
        results.push({
          estateId: estate.id,
          estateName: estate.name,
          success: false,
          error: "No connected repository",
        });
        continue;
      }

      try {
        const result = await triggerEstateRebuild({
          db: ctx.db,
          env: ctx.env,
          estateId: estate.id,
          commitHash: estate.connectedRepoRef || "main",
          commitMessage: "Bulk rebuild triggered by admin",
          isManual: true,
        });

        results.push({
          estateId: estate.id,
          estateName: estate.name,
          success: true,
          buildId: result.id,
        });
      } catch (error) {
        results.push({
          estateId: estate.id,
          estateName: estate.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return {
      total: estates.length,
      results,
    };
  }),
});
