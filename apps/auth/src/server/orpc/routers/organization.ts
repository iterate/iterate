import { ORPCError } from "@orpc/server";
import { slugify } from "@iterate-com/shared/slug";
import {
  organizationAdminMiddleware,
  organizationScopedMiddleware,
  os,
  protectedMiddleware,
} from "../orpc.ts";
import {
  deleteInviteByIdAndOrganizationId,
  deleteMembershipByOrganizationAndUserId,
  deleteOrganizationById,
  getInviteByOrganizationAndEmail,
  getMembershipByOrganizationAndUserId,
  getOrganizationBySlug,
  getOrganizationMemberPresenceByEmail,
  getPendingInviteByIdAndEmail,
  insertInvite,
  insertMembership,
  insertOrganization,
  listInvitesByOrganizationId,
  listMembersByOrganizationId,
  listPendingInvitesByEmail,
  updateInviteStatusById,
  updateMembershipRoleByOrganizationAndUserId,
  updateOrganizationNameById,
} from "../../db/queries/index.ts";
import { generateId, toMembershipRole, toOrganizationRecord, toUserRecord } from "./_shared.ts";

const create = os.organization.create
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const baseSlug = slugify(input.name);
    const existing = await getOrganizationBySlug(context.db, { slug: baseSlug });
    if (existing) {
      throw new ORPCError("CONFLICT", { message: "An organization with this slug already exists" });
    }

    const organizationId = generateId("org");
    const now = Date.now();
    await context.db.transaction(async (tx) => {
      await insertOrganization(tx, {
        id: organizationId,
        name: input.name,
        slug: baseSlug,
        createdAt: now,
        metadata: null,
        logo: null,
      });

      await insertMembership(tx, {
        id: generateId("member"),
        organizationId,
        userId: context.user.id,
        role: "owner",
        createdAt: now,
      });
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
    const role = context.membership?.role ?? (context.user.role === "admin" ? "admin" : undefined);
    if (!role) {
      throw new ORPCError("FORBIDDEN", {
        message: "You do not have access to this organization",
      });
    }

    return {
      ...toOrganizationRecord(context.organization),
      role: toMembershipRole(role),
    };
  });

const update = os.organization.update
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    await updateOrganizationNameById(
      context.db,
      {
        name: input.name,
      },
      {
        id: context.organization.id,
      },
    );

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

    await deleteOrganizationById(context.db, { id: context.organization.id });

    return { success: true as const };
  });

const members = os.organization.members
  .use(organizationScopedMiddleware)
  .handler(async ({ context }) => {
    const members = await listMembersByOrganizationId(context.db, {
      organizationId: context.organization.id,
    });

    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: toMembershipRole(member.role),
      user: toUserRecord({
        id: member.userId,
        name: member.userName,
        email: member.userEmail,
        image: member.userImage ?? null,
        role: member.userRole ?? null,
      }),
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

    await updateMembershipRoleByOrganizationAndUserId(
      context.db,
      {
        role: input.role,
      },
      {
        organizationId: context.organization.id,
        userId: input.userId,
      },
    );

    return { success: true as const };
  });

const removeMember = os.organization.removeMember
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    if (input.userId === context.user.id) {
      throw new ORPCError("FORBIDDEN", { message: "Cannot remove yourself" });
    }

    const targetMembership = await getMembershipByOrganizationAndUserId(context.db, {
      organizationId: context.organization.id,
      userId: input.userId,
    });

    if (
      targetMembership?.role === "owner" &&
      context.membership?.role !== "owner" &&
      context.user.role !== "admin"
    ) {
      throw new ORPCError("FORBIDDEN", { message: "Only owners can remove other owners" });
    }

    await deleteMembershipByOrganizationAndUserId(context.db, {
      organizationId: context.organization.id,
      userId: input.userId,
    });

    return { success: true as const };
  });

const createInvite = os.organization.createInvite
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    const existingInvite = await getInviteByOrganizationAndEmail(context.db, {
      organizationId: context.organization.id,
      email: input.email,
    });
    if (existingInvite) {
      throw new ORPCError("CONFLICT", { message: "Invite already exists" });
    }

    const existingMember = await getOrganizationMemberPresenceByEmail(context.db, {
      organizationId: context.organization.id,
      email: input.email,
    });
    if (existingMember) {
      throw new ORPCError("CONFLICT", { message: "User is already a member" });
    }

    const inviteId = generateId("inv");
    const role = input.role ?? "member";
    await insertInvite(context.db, {
      id: inviteId,
      organizationId: context.organization.id,
      email: input.email,
      role,
      status: "pending",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
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
    const invites = await listInvitesByOrganizationId(context.db, {
      organizationId: context.organization.id,
    });

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: toMembershipRole(invite.role),
      organization: toOrganizationRecord({
        id: invite.organizationRecordId,
        name: invite.organizationName,
        slug: invite.organizationSlug,
      }),
      invitedBy: {
        id: invite.inviterId,
        name: invite.inviterName,
        email: invite.inviterEmail,
      },
    }));
  });

const cancelInvite = os.organization.cancelInvite
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    await deleteInviteByIdAndOrganizationId(context.db, {
      id: input.inviteId,
      organizationId: context.organization.id,
    });

    return { success: true as const };
  });

const myPendingInvites = os.organization.myPendingInvites
  .use(protectedMiddleware)
  .handler(async ({ context }) => {
    const invites = await listPendingInvitesByEmail(context.db, {
      email: context.user.email,
    });

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: toMembershipRole(invite.role),
      organization: toOrganizationRecord({
        id: invite.organizationRecordId,
        name: invite.organizationName,
        slug: invite.organizationSlug,
      }),
      invitedBy: {
        id: invite.inviterId,
        name: invite.inviterName,
      },
    }));
  });

const acceptInvite = os.organization.acceptInvite
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const invite = await getPendingInviteByIdAndEmail(context.db, {
      id: input.inviteId,
      email: context.user.email,
    });
    if (!invite) {
      throw new ORPCError("NOT_FOUND", { message: "Invite not found" });
    }

    const existingMembership = await getMembershipByOrganizationAndUserId(context.db, {
      organizationId: invite.organizationId,
      userId: context.user.id,
    });
    await context.db.transaction(async (tx) => {
      if (!existingMembership) {
        await insertMembership(tx, {
          id: generateId("member"),
          organizationId: invite.organizationId,
          userId: context.user.id,
          role: invite.role ?? "member",
          createdAt: Date.now(),
        });
      }

      await updateInviteStatusById(
        tx,
        {
          status: "accepted",
        },
        {
          id: invite.id,
        },
      );
    });

    return toOrganizationRecord({
      id: invite.organizationRecordId,
      name: invite.organizationName,
      slug: invite.organizationSlug,
    });
  });

const declineInvite = os.organization.declineInvite
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const invite = await getPendingInviteByIdAndEmail(context.db, {
      id: input.inviteId,
      email: context.user.email,
    });
    if (!invite) {
      throw new ORPCError("NOT_FOUND", { message: "Invite not found" });
    }

    await updateInviteStatusById(
      context.db,
      {
        status: "declined",
      },
      {
        id: invite.id,
      },
    );

    return { success: true as const };
  });

const leave = os.organization.leave
  .use(organizationScopedMiddleware)
  .handler(async ({ context }) => {
    await deleteMembershipByOrganizationAndUserId(context.db, {
      organizationId: context.organization.id,
      userId: context.user.id,
    });

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
