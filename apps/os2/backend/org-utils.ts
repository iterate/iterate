import type { User } from "better-auth";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { generateSlugFromEmail, generateSlugFromName } from "./utils/slug.ts";

export async function createUserOrganizationAndInstance(db: DB, user: User) {
  const orgSlug = generateSlugFromEmail(user.email);
  const instanceSlug = generateSlugFromName("default");

  const [organization] = await db
    .insert(schema.organization)
    .values({
      name: orgSlug,
      slug: orgSlug,
    })
    .returning();

  await db.insert(schema.organizationUserMembership).values({
    organizationId: organization.id,
    userId: user.id,
    role: "owner",
  });

  const [instance] = await db
    .insert(schema.instance)
    .values({
      name: "Default",
      slug: instanceSlug,
      organizationId: organization.id,
    })
    .returning();

  return { organization, instance };
}
