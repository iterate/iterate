import { eq } from "drizzle-orm";
import dedent from "dedent";
import { typeid } from "typeid-js";
import { waitUntil, env } from "../env.ts";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { sendNotificationToIterateSlack } from "./integrations/slack/slack-utils.ts";
import { getUserOrganizations } from "./trpc/trpc.ts";
import { getOctokitForInstallation } from "./integrations/github/github-utils.ts";
import { outboxClient } from "./outbox/client.ts";

export const createGithubRepoInEstatePool = async (metadata: {
  organizationId: string;
  organizationName: string;
}) => {
  const gh = await getOctokitForInstallation(env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID);
  const repoName = typeid("repo").toString();
  const repo = await gh.rest.repos.createUsingTemplate({
    name: repoName,
    template_owner: "iterate",
    template_repo: "estate-template",
    owner: "iterate-estates",
    private: true,
    description: JSON.stringify(metadata),
  });

  if (repo.status !== 201 || !repo.data) {
    throw new Error(`Failed to create repository: ${JSON.stringify(repo.data)}`);
  }

  await gh.rest.repos.update({
    owner: repo.data.owner.login,
    repo: repo.data.name,
    homepage: `${env.VITE_PUBLIC_URL}/${metadata.organizationId}`,
  });

  return repo.data;
};

// not great thing 1: the onboarding agent "name" is now actually a routing key, but passed around as a name for backwards compatibility
// not great thing 2: we are sometimes summoning the onboarding agent by its name/route, but relying on a naming convention rather than getting it from the db
// not great thing 3: onboardingAgentName shouldn't really be a column on the estate table.
export const getDefaultOnboardingAgentName = (estateId: string) => `${estateId}-Onboarding`;

async function createOrganizationAndEstateInTransaction(
  tx: DBLike,
  params: {
    organizationName: string;
    ownerUserId: string;
    estateName?: string;
  },
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  estate: typeof schema.estate.$inferSelect;
}> {
  const { organizationName, ownerUserId, estateName } = params;

  const [organization] = await tx
    .insert(schema.organization)
    .values({ name: organizationName })
    .returning();
  if (!organization) throw new Error("Failed to create organization");

  await tx.insert(schema.organizationUserMembership).values({
    organizationId: organization.id,
    userId: ownerUserId,
    role: "owner",
  });

  const [estate] = await tx
    .insert(schema.estate)
    .values({
      name: estateName ?? `${organizationName} Estate`,
      organizationId: organization.id,
    })
    .returning();
  if (!estate) throw new Error("Failed to create estate");

  const onboardingAgentName = getDefaultOnboardingAgentName(estate.id);
  await tx
    .update(schema.estate)
    .set({ onboardingAgentName }) // todo: mv onboardingAgentName off the estate table, it's messy having to insert and then immediately update the estate row
    .where(eq(schema.estate.id, estate.id));

  // Insert the EstateCreated tracking event
  await tx
    .insert(schema.estateOnboardingEvent)
    .values({
      estateId: estate.id,
      organizationId: organization.id,
      eventType: "EstateCreated",
      category: "system",
      detail: `Onboarding agent: ${onboardingAgentName}`,
    })

    .onConflictDoNothing();

  return { organization, estate };
}

export async function createOrganizationAndEstate(
  db: DB,
  params: {
    organizationName: string;
    ownerUserId: string;
    estateName?: string;
  },
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  estate: typeof schema.estate.$inferSelect;
}> {
  return outboxClient.sendTx(db, "estate:created", async (tx) => {
    const result = await createOrganizationAndEstateInTransaction(tx, params);
    return { payload: { estateId: result.estate.id }, ...result };
  });
}

// Function to create organization and estate for new users
export const createUserOrganizationAndEstate = async (
  db: DB,
  user: {
    id: string;
    name: string;
    email: string;
  },
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  estate?: typeof schema.estate.$inferSelect;
}> => {
  // Check if user already has a non-external organization
  const existingMemberships = await getUserOrganizations(db, user.id);
  // Only create organization and estate for new users
  // External users should get a new organization created
  if (existingMemberships.length > 0) {
    return {
      organization: existingMemberships[0].organization,
    };
  }

  // Create repo first, then centralize DB work via shared helper
  const provisionalOrgName = `${user.email}'s Organization`;
  // todo: create an iterate-estates/ repo in a consumer

  const { organization, estate } = await createOrganizationAndEstate(db, {
    organizationName: provisionalOrgName,
    ownerUserId: user.id,
    estateName: `${user.email}'s primary estate`,
  });

  const result = { organization, estate };

  // Send Slack notification to our own slack instance, unless suppressed for test users
  // In production ITERATE_NOTIFICATION_ESTATE_ID is set to iterate's own iterate estate id
  if (env.ITERATE_NOTIFICATION_ESTATE_ID) {
    const userRecord = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, user.id) });
    const shouldSuppress = isTestSignup(user.name, userRecord?.email, organization.name);

    if (!shouldSuppress) {
      waitUntil(
        sendEstateCreatedNotificationToSlack(result.organization, result.estate).catch((error) => {
          logger.error("Failed to send Slack notification for new estate", error);
        }),
      );
    }
  }
  return result;
};

type DBLike = Pick<DB, "insert" | "update" | "query">;

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

function isTestSignup(
  userName: string,
  userEmail: string | undefined,
  organizationName: string,
): boolean {
  // Add example.com to the patterns to catch test onboarding users
  if (userEmail?.endsWith("@example.com")) return true;
  if (userEmail?.match(/^[\w.-]+\+\d+@(nustom|iterate)\.com$/)) return true;

  const raw = env.TEST_USER_PATTERNS;
  if (!raw) return false;

  const patterns = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (patterns.length === 0) return false;

  const valuesToTest = [userName, organizationName, userEmail ?? ""].map((v) => v.toLowerCase());

  for (const pattern of patterns) {
    for (const value of valuesToTest) {
      if (value.includes(pattern)) return true;
    }
  }
  return false;
}
