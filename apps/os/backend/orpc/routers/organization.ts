import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import {
  protectedProcedure,
  protectedMutation,
  orgProtectedProcedure,
  orgAdminMutation,
  OrgInput,
} from "../procedures.ts";
import * as schema from "../../db/schema.ts";
import { UserRole } from "../../db/schema.ts";
import { authClientFor } from "../../utils/auth-worker-client.ts";
import { listProjectsForOrganizationFromAuthWorker } from "../../auth/auth-context.ts";

export const organizationRouter = {
  create: protectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.create({
        name: input.name,
      });
    }),

  bySlug: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    return {
      ...ctx.organization,
      role: ctx.membership?.role,
    };
  }),

  withProjects: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    const projects = await listProjectsForOrganizationFromAuthWorker({
      db: ctx.db,
      authUserId: ctx.user.authUserId!,
      organizationSlug: ctx.organization.slug,
    });

    return {
      ...ctx.organization,
      projects,
      role: ctx.membership?.role,
    };
  }),

  update: orgAdminMutation
    .input(
      z.object({
        ...OrgInput.shape,
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.update({
        organizationSlug: ctx.organization.slug,
        name: input.name ?? ctx.organization.name,
      });
    }),

  members: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    return authClientFor(ctx).organization.members({
      organizationSlug: ctx.organization.slug,
    });
  }),

  addMember: orgAdminMutation
    .input(
      z.object({
        ...OrgInput.shape,
        email: z.string().email(),
        role: z.enum(UserRole).optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.createInvite({
        organizationSlug: ctx.organization.slug,
        email: input.email,
        role: input.role,
      });
    }),

  updateMemberRole: orgAdminMutation
    .input(
      z.object({
        ...OrgInput.shape,
        userId: z.string(),
        role: z.enum(UserRole),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.updateMemberRole({
        organizationSlug: ctx.organization.slug,
        userId: input.userId,
        role: input.role,
      });
    }),

  removeMember: orgAdminMutation
    .input(
      z.object({
        ...OrgInput.shape,
        userId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.removeMember({
        organizationSlug: ctx.organization.slug,
        userId: input.userId,
      });
    }),

  delete: orgAdminMutation.input(OrgInput).handler(async ({ context: ctx }) => {
    if (ctx.membership?.role !== "owner" && ctx.user.role !== "admin") {
      throw new ORPCError("FORBIDDEN", { message: "Only owners can delete organizations" });
    }

    await authClientFor(ctx).organization.delete({
      organizationSlug: ctx.organization.slug,
    });

    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.billingAccount)
        .where(eq(schema.billingAccount.authOrganizationId, ctx.organization.id));
      await tx
        .delete(schema.project)
        .where(eq(schema.project.authOrganizationId, ctx.organization.id));
    });

    return { success: true };
  }),

  createInvite: orgAdminMutation
    .input(
      z.object({
        ...OrgInput.shape,
        email: z.email(),
        role: z.enum(UserRole).optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.createInvite({
        organizationSlug: ctx.organization.slug,
        email: input.email,
        role: input.role,
      });
    }),

  listInvites: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    return authClientFor(ctx).organization.listInvites({
      organizationSlug: ctx.organization.slug,
    });
  }),

  cancelInvite: orgAdminMutation
    .input(z.object({ ...OrgInput.shape, inviteId: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.cancelInvite({
        organizationSlug: ctx.organization.slug,
        inviteId: input.inviteId,
      });
    }),

  myPendingInvites: protectedProcedure.handler(async ({ context: ctx }) => {
    return authClientFor(ctx).organization.myPendingInvites();
  }),

  acceptInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.acceptInvite({
        inviteId: input.inviteId,
      });
    }),

  declineInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      return authClientFor(ctx).organization.declineInvite({
        inviteId: input.inviteId,
      });
    }),

  leave: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    await authClientFor(ctx).organization.leave({
      organizationSlug: ctx.organization.slug,
    });

    return { success: true };
  }),
};
