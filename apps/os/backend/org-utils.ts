import { waitUntil } from "cloudflare:workers";
import dedent from "dedent";
import { env } from "../env.ts";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { sendNotificationToIterateSlack } from "./integrations/slack/slack-utils.ts";

// Function to create organization and estate for new users
export const createUserOrganizationAndEstate = async (
  db: DB,
  userId: string,
  userName: string,
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  estate?: typeof schema.estate.$inferSelect;
}> => {
  const existingMembership = await db.query.organizationUserMembership.findFirst({
    where: (membership, { eq }) => eq(membership.userId, userId),
    with: {
      organization: true,
    },
  });

  // Only create organization and estate for new users
  if (existingMembership) {
    return {
      organization: existingMembership.organization,
    };
  }

  // Perform sequential inserts without opening a new transaction to avoid
  // cross-transaction FK visibility issues with the user record.
  // If the auth layer wraps this in a transaction, these operations will be part of it.
  const organizationResult = await db
    .insert(schema.organization)
    .values({ name: `${userName}'s Organization` })
    .returning();

  const organization = organizationResult[0];

  if (!organization) {
    throw new Error("Failed to create organization");
  }

  await db.insert(schema.organizationUserMembership).values({
    organizationId: organization.id,
    userId: userId,
    role: "owner",
  });

  const [estate] = await db
    .insert(schema.estate)
    .values({
      name: `${userName}'s Estate`,
      organizationId: organization.id,
    })
    .returning();

  if (!estate) {
    throw new Error("Failed to create estate");
  }

  const result = { organization, estate };

  // Send Slack notification to our own slack instance
  // In production ITERATE_NOTIFICATION_ESTATE_ID is set to iterate's own iterate estate id
  if (env.ITERATE_NOTIFICATION_ESTATE_ID) {
    waitUntil(
      sendEstateCreatedNotificationToSlack(result.organization, result.estate).catch((error) => {
        logger.error("Failed to send Slack notification for new estate", error);
      }),
    );
  }
  return result;
};

async function sendEstateCreatedNotificationToSlack(
  organization: typeof schema.organization.$inferSelect,
  estate: typeof schema.estate.$inferSelect,
) {
  // Construct the impersonation link
  const impersonationUrl = `${env.VITE_PUBLIC_URL}/${organization.id}/${estate.id}`;

  const message = dedent`
    🎉 New user signed up!
    • Estate: ${estate.name}
    • Estate ID: \`${estate.id}\`
    • Organization: ${organization.name}
    • Organization ID: \`${organization.id}\`
    Visit estate: <${impersonationUrl}|Open Estate>
  `;

  await sendNotificationToIterateSlack(message, "#general");
}
