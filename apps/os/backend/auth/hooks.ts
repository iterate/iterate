import { waitUntil } from "cloudflare:workers";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";
import { logger as console } from "../tag-logger.ts";
import { sendNotificationToIterateSlack } from "../integrations/slack/slack-utils.ts";

// Function to create organization and estate for new users
export const createUserOrganizationAndEstate = async (db: DB, userId: string, userName: string) => {
  const existingMembership = await db.query.organizationUserMembership.findFirst({
    where: (membership, { eq }) => eq(membership.userId, userId),
  });

  // Only create organization and estate for new users
  if (!existingMembership) {
    // Use a transaction to ensure atomicity
    const result = await db.transaction(async (tx) => {
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
      return { organization, estate };
    });

    // Send Slack notification to our own slack instance
    // In production ITERATE_NOTIFICATION_ESTATE_ID is set to iterate's own iterate estate id
    if (env.ITERATE_NOTIFICATION_ESTATE_ID) {
      waitUntil(
        sendEstateCreatedNotificationToSlack(result.organization, result.estate).catch((error) => {
          console.error("Failed to send Slack notification for new estate", error);
        }),
      );
    }
  }
};

async function sendEstateCreatedNotificationToSlack(
  organization: typeof schema.organization.$inferSelect,
  estate: typeof schema.estate.$inferSelect,
) {
  // Construct the impersonation link
  const impersonationUrl = `${env.VITE_PUBLIC_URL}/${organization.id}/${estate.id}`;

  const message = `🎉 New user signed up!

• Estate: ${estate.name}
• Estate ID: \`${estate.id}\`
• Organization: ${organization.name}
• Organization ID: \`${organization.id}\`

Visit estate: <${impersonationUrl}|Open Estate>
`;

  await sendNotificationToIterateSlack(message, "#general");
}
