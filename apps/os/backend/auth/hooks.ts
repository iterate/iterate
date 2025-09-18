import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";

// Function to create organization and estate for new users
export const createUserOrganizationAndEstate = async (db: DB, userId: string, userName: string) => {
  const existingMembership = await db.query.organizationUserMembership.findFirst({
    where: (membership, { eq }) => eq(membership.userId, userId),
  });

  // Only create organization and estate for new users
  if (!existingMembership) {
    // Use a transaction to ensure atomicity
    await db.transaction(async (tx) => {
      // Create organization
      const organizationResult = await tx
        .insert(schema.organization)
        .values({
          name: `${userName}'s Organization`,
        })
        .returning();

      const organization = organizationResult[0];

      if (!organization) {
        throw new Error("Failed to create organization");
      }

      // Create organization membership for the user
      await tx.insert(schema.organizationUserMembership).values({
        organizationId: organization.id,
        userId: userId,
        role: "owner",
      });

      // Create estate
      const [estate] = await tx
        .insert(schema.estate)
        .values({
          name: `${userName}'s Estate`,
          organizationId: organization.id,
        })
        .returning();

      if (!estate) {
        throw new Error("Failed to create estate");
      }
    });
  }
};
