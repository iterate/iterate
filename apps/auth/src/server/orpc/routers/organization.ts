import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { slugify } from "@iterate-com/shared/slug";
import {
  organizationAdminMiddleware,
  organizationScopedMiddleware,
  os,
  protectedMiddleware,
} from "../orpc.ts";
import { schema } from "../../db/index.ts";
import { generateId, toMembershipRole, toOrganizationRecord, toUserRecord } from "./_shared.ts";

const create = os.organization.create
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const baseSlug = slugify(input.name);
    const existing = await context.db.query.organization.findFirst({
      where: eq(schema.organization.slug, baseSlug),
    });
    if (existing) {
      throw new ORPCError("CONFLICT", { message: "An organization with this slug already exists" });
    }

    const organizationId = generateId("org");
    await context.db.insert(schema.organization).values({
      id: organizationId,
      name: input.name,
      slug: baseSlug,
      createdAt: new Date(),
      metadata: null,
      logo: null,
    });

    await context.db.insert(schema.member).values({
      id: generateId("member"),
      organizationId,
      userId: context.user.id,
      role: "owner",
      createdAt: new Date(),
    });

    return {
      id: organizationId,
      name: input.name,
      slug: baseSlug,
    };
  });

const bySlug = os.organization.bySlug
  .use(organizationScopedMiddleware)
  .handler(async ({ context }) => {
    return {
      ...toOrganizationRecord(context.organization),
      role: toMembershipRole(context.membership?.role ?? "owner"),
    };
  });

const update = os.organization.update
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    await context.db
      .update(schema.organization)
      .set({
        name: input.name,
      })
      .where(eq(schema.organization.id, context.organization.id));

    return {
      id: context.organization.id,
      name: input.name,
      slug: context.organization.slug,
    };
  });

const remove = os.organization.delete
  .use(organizationAdminMiddleware)
  .handler(async ({ context }) => {
    const membershipRole = context.membership?.role;
    const isSystemAdmin = context.user.role === "admin";
    if (!isSystemAdmin && membershipRole !== "owner") {
      throw new ORPCError("FORBIDDEN", { message: "Only owners can delete organizations" });
    }

    await context.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, context.organization.id));

    return { success: true as const };
  });

const members = os.organization.members
  .use(organizationScopedMiddleware)
  .handler(async ({ context }) => {
    const members = await context.db.query.member.findMany({
      where: eq(schema.member.organizationId, context.organization.id),
      with: {
        user: true,
      },
    });

    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: toMembershipRole(member.role),
      user: toUserRecord(member.user),
    }));
  });

const updateMemberRole = os.organization.updateMemberRole
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    if (input.userId === context.user.id) {
      throw new ORPCError("FORBIDDEN", { message: "Cannot change your own role" });
    }

    if (
      input.role === "owner" &&
      context.membership?.role !== "owner" &&
      context.user.role !== "admin"
    ) {
      throw new ORPCError("FORBIDDEN", { message: "Only owners can promote to owner" });
    }

    await context.db
      .update(schema.member)
      .set({
        role: input.role,
      })
      .where(
        and(
          eq(schema.member.organizationId, context.organization.id),
          eq(schema.member.userId, input.userId),
        ),
      );

    return { success: true as const };
  });

const removeMember = os.organization.removeMember
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    if (input.userId === context.user.id) {
      throw new ORPCError("FORBIDDEN", { message: "Cannot remove yourself" });
    }

    const targetMembership = await context.db.query.member.findFirst({
      where: and(
        eq(schema.member.organizationId, context.organization.id),
        eq(schema.member.userId, input.userId),
      ),
    });

    if (
      targetMembership?.role === "owner" &&
      context.membership?.role !== "owner" &&
      context.user.role !== "admin"
    ) {
      throw new ORPCError("FORBIDDEN", { message: "Only owners can remove other owners" });
    }

    await context.db
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, context.organization.id),
          eq(schema.member.userId, input.userId),
        ),
      );

    return { success: true as const };
  });

const createInvite = os.organization.createInvite
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    const existingInvite = await context.db.query.invitation.findFirst({
      where: and(
        eq(schema.invitation.organizationId, context.organization.id),
        eq(schema.invitation.email, input.email),
      ),
    });
    if (existingInvite) {
      throw new ORPCError("CONFLICT", { message: "Invite already exists" });
    }

    const existingMember = await context.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
      with: {
        members: true,
      },
    });
    if (
      existingMember?.members.some((member) => member.organizationId === context.organization.id)
    ) {
      throw new ORPCError("CONFLICT", { message: "User is already a member" });
    }

    const inviteId = generateId("inv");
    const role = input.role ?? "member";
    await context.db.insert(schema.invitation).values({
      id: inviteId,
      organizationId: context.organization.id,
      email: input.email,
      role,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterId: context.user.id,
    });

    return {
      id: inviteId,
      email: input.email,
      role,
      invitedBy: {
        id: context.user.id,
        name: context.user.name,
        email: context.user.email,
      },
    };
  });

const listInvites = os.organization.listInvites
  .use(organizationScopedMiddleware)
  .handler(async ({ context }) => {
    const invites = await context.db.query.invitation.findMany({
      where: eq(schema.invitation.organizationId, context.organization.id),
      with: {
        organization: true,
        user: true,
      },
    });

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: toMembershipRole(invite.role),
      organization: toOrganizationRecord(invite.organization),
      invitedBy: {
        id: invite.user.id,
        name: invite.user.name,
        email: invite.user.email,
      },
    }));
  });

const cancelInvite = os.organization.cancelInvite
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    await context.db
      .delete(schema.invitation)
      .where(
        and(
          eq(schema.invitation.id, input.inviteId),
          eq(schema.invitation.organizationId, context.organization.id),
        ),
      );

    return { success: true as const };
  });

const myPendingInvites = os.organization.myPendingInvites
  .use(protectedMiddleware)
  .handler(async ({ context }) => {
    const invites = await context.db.query.invitation.findMany({
      where: and(
        eq(schema.invitation.email, context.user.email),
        eq(schema.invitation.status, "pending"),
      ),
      with: {
        organization: true,
        user: true,
      },
    });

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: toMembershipRole(invite.role),
      organization: toOrganizationRecord(invite.organization),
      invitedBy: {
        id: invite.user.id,
        name: invite.user.name,
      },
    }));
  });

const acceptInvite = os.organization.acceptInvite
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const invite = await context.db.query.invitation.findFirst({
      where: and(
        eq(schema.invitation.id, input.inviteId),
        eq(schema.invitation.email, context.user.email),
        eq(schema.invitation.status, "pending"),
      ),
      with: {
        organization: true,
      },
    });
    if (!invite) {
      throw new ORPCError("NOT_FOUND", { message: "Invite not found" });
    }

    const existingMembership = await context.db.query.member.findFirst({
      where: and(
        eq(schema.member.organizationId, invite.organizationId),
        eq(schema.member.userId, context.user.id),
      ),
    });
    if (!existingMembership) {
      await context.db.insert(schema.member).values({
        id: generateId("member"),
        organizationId: invite.organizationId,
        userId: context.user.id,
        role: invite.role ?? "member",
        createdAt: new Date(),
      });
    }

    await context.db
      .update(schema.invitation)
      .set({ status: "accepted" })
      .where(eq(schema.invitation.id, invite.id));

    return toOrganizationRecord(invite.organization);
  });

const declineInvite = os.organization.declineInvite
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const invite = await context.db.query.invitation.findFirst({
      where: and(
        eq(schema.invitation.id, input.inviteId),
        eq(schema.invitation.email, context.user.email),
        eq(schema.invitation.status, "pending"),
      ),
    });
    if (!invite) {
      throw new ORPCError("NOT_FOUND", { message: "Invite not found" });
    }

    await context.db
      .update(schema.invitation)
      .set({ status: "declined" })
      .where(eq(schema.invitation.id, invite.id));

    return { success: true as const };
  });

const leave = os.organization.leave
  .use(organizationScopedMiddleware)
  .handler(async ({ context }) => {
    await context.db
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, context.organization.id),
          eq(schema.member.userId, context.user.id),
        ),
      );

    return { success: true as const };
  });

export const organization = os.organization.router({
  create,
  update,
  delete: remove,
  bySlug,
  members,
  updateMemberRole,
  removeMember,
  createInvite,
  listInvites,
  cancelInvite,
  myPendingInvites,
  acceptInvite,
  declineInvite,
  leave,
});
