import { ORPCError } from "@orpc/server";
import { os, protectedMiddleware } from "../orpc.ts";
import { listOrganizationsForUser } from "../../db/queries/index.ts";
import { toMembershipRole, toUserRecord } from "./_shared.ts";

const me = os.user.me.handler(async ({ context }) => {
  if (context.session) {
    return toUserRecord(context.session.user);
  }

  if (context.projectIngressUser) {
    return toUserRecord(context.projectIngressUser);
  }

  throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
});

const myOrganizations = os.user.myOrganizations
  .use(protectedMiddleware)
  .handler(async ({ context }) => {
    const memberships = await listOrganizationsForUser(context.db, {
      userId: context.user.id,
    });

    return memberships.map((membership) => ({
      id: membership.id,
      name: membership.name,
      slug: membership.slug,
      role: toMembershipRole(membership.role),
    }));
  });

export const user = os.user.router({
  me,
  myOrganizations,
});
