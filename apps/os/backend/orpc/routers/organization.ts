import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import {
  protectedProcedure,
  protectedMutation,
  orgProtectedProcedure,
  orgAdminMutation,
  OrgInput,
} from "../procedures.ts";
import { organizationUserMembership, organization, UserRole } from "../../db/schema.ts";
import { createAuthWorkerClient } from "../../utils/auth-worker-client.ts";
import { syncOrganizationMembershipShadowsFromAuthWorker } from "../../auth/auth-context.ts";

export const organizationRouter = {
  create: protectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      const createdAuthOrganization = await authClient.organization.create({
        name: input.name,
      });
      return syncOrganizationMembershipShadowsFromAuthWorker({
        db: ctx.db,
        authUserId: ctx.user.authUserId!,
        organizationSlug: createdAuthOrganization.slug,
        authOrganization: createdAuthOrganization,
      });
    }),

  bySlug: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    return {
      ...ctx.organization,
      role: ctx.membership?.role,
    };
  }),

  withProjects: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    const org = await ctx.db.query.organization.findFirst({
      where: eq(organization.id, ctx.organization.id),
      with: {
        projects: true,
      },
    });

    return {
      ...org,
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
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      const updatedAuthOrganization = await authClient.organization.update({
        organizationSlug: ctx.organization.slug,
        name: input.name ?? ctx.organization.name,
      });

      const [updated] = await ctx.db
        .update(organization)
        .set({
          name: updatedAuthOrganization.name,
          slug: updatedAuthOrganization.slug,
        })
        .where(eq(organization.id, ctx.organization.id))
        .returning();

      return updated ?? ctx.organization;
    }),

  members: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
    return authClient.organization.members({
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
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      return authClient.organization.createInvite({
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
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      return authClient.organization.updateMemberRole({
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
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      return authClient.organization.removeMember({
        organizationSlug: ctx.organization.slug,
        userId: input.userId,
      });
    }),

  delete: orgAdminMutation.input(OrgInput).handler(async ({ context: ctx }) => {
    if (ctx.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", { message: "Only owners can delete organizations" });
    }

    await ctx.db.delete(organization).where(eq(organization.id, ctx.organization.id));

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
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      return authClient.organization.createInvite({
        organizationSlug: ctx.organization.slug,
        email: input.email,
        role: input.role,
      });
    }),

  listInvites: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
    return authClient.organization.listInvites({
      organizationSlug: ctx.organization.slug,
    });
  }),

  cancelInvite: orgAdminMutation
    .input(z.object({ ...OrgInput.shape, inviteId: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      return authClient.organization.cancelInvite({
        organizationSlug: ctx.organization.slug,
        inviteId: input.inviteId,
      });
    }),

  myPendingInvites: protectedProcedure.handler(async ({ context: ctx }) => {
    const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
    return authClient.organization.myPendingInvites();
  }),

  acceptInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      const acceptedOrganization = await authClient.organization.acceptInvite({
        inviteId: input.inviteId,
      });
      return syncOrganizationMembershipShadowsFromAuthWorker({
        db: ctx.db,
        authUserId: ctx.user.authUserId!,
        organizationSlug: acceptedOrganization.slug,
        authOrganization: acceptedOrganization,
      });
    }),

  declineInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      return authClient.organization.declineInvite({
        inviteId: input.inviteId,
      });
    }),

  leave: orgProtectedProcedure.input(OrgInput).handler(async ({ context: ctx }) => {
    const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
    await authClient.organization.leave({
      organizationSlug: ctx.organization.slug,
    });

    await ctx.db
      .delete(organizationUserMembership)
      .where(
        and(
          eq(organizationUserMembership.organizationId, ctx.organization.id),
          eq(organizationUserMembership.userId, ctx.user.id),
        ),
      );

    return { success: true };
  }),
};
