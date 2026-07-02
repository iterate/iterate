import { ORPCError } from "@orpc/server";
import { slugify } from "@iterate-com/shared/slug";
import { organizationAdminMiddleware, os, protectedMiddleware } from "../orpc.ts";
import {
  deleteOrganizationById,
  getOrganizationBySlug,
  insertMembership,
  insertOrganization,
} from "../../db/queries/index.ts";
import { generateId } from "../../records.ts";

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

export const organization = os.organization.router({
  create,
  delete: remove,
});
