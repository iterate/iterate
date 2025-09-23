import { eq, and } from "drizzle-orm";
import { WebClient, type UsersListResponse } from "@slack/web-api";
import * as schema from "../db/schema.ts";
import { getDb } from "../db/client.ts";

export async function saveSlackUserMapping(
  db: ReturnType<typeof getDb>,
  member: NonNullable<UsersListResponse["members"]>[number],
) {
  await db.transaction(async (tx) => {
    if (!member.id || !member.profile?.email || member.deleted) {
      return;
    }
    const existingMapping = await tx.query.providerUserMapping.findFirst({
      where: and(
        eq(schema.providerUserMapping.providerId, "slack-bot"),
        eq(schema.providerUserMapping.externalId, member.id),
      ),
    });

    if (existingMapping) {
      await tx
        .update(schema.user)
        .set({
          name: member.real_name || member.name || undefined,
          email: member.profile.email,
          image: member.profile?.image_192,
          emailVerified: false,
        })
        .where(eq(schema.user.id, existingMapping.internalUserId));
      await tx
        .update(schema.providerUserMapping)
        .set({
          providerMetadata: member,
        })
        .where(eq(schema.providerUserMapping.id, existingMapping.id));
      return;
    }

    const existingUser = await tx.query.user.findFirst({
      where: eq(schema.user.email, member.profile.email),
    });

    if (existingUser) {
      await tx
        .update(schema.user)
        .set({
          name: member.real_name || member.name || "",
          image: member.profile?.image_192,
        })
        .where(eq(schema.user.id, existingUser.id));

      await tx.insert(schema.providerUserMapping).values({
        providerId: "slack-bot",
        internalUserId: existingUser.id,
        externalId: member.id,
        providerMetadata: member,
      });

      return;
    }
    const newUser = await tx
      .insert(schema.user)
      .values({
        name: member.real_name || member.name || "",
        email: member.profile.email,
        image: member.profile?.image_192,
        emailVerified: false,
      })
      .returning();

    await tx.insert(schema.providerUserMapping).values({
      providerId: "slack-bot",
      internalUserId: newUser[0].id,
      externalId: member.id,
      providerMetadata: member,
    });
  });
}

export async function syncSlackUsersInBackground(botToken: string) {
  const authedWebClient = new WebClient(botToken);
  const userListResponse = await authedWebClient.users.list({});
  if (userListResponse.ok && userListResponse.members) {
    const db = getDb();
    await Promise.allSettled(
      userListResponse.members.map(async (member) => {
        await saveSlackUserMapping(db, member);
      }),
    );
  }
}
