import { ORPCError } from "@orpc/server";
import { os, protectedMiddleware } from "../orpc.ts";
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
    const memberships = await context.db.query.member.findMany({
      where: (member, { eq }) => eq(member.userId, context.user.id),
      with: {
        organization: true,
      },
    });

    return memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: toMembershipRole(membership.role),
    }));
  });

export const user = os.user.router({
  me,
  myOrganizations,
});
