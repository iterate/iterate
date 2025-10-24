import { eq } from "drizzle-orm";
import dedent from "dedent";
import { typeid } from "typeid-js";
import { waitUntil, env } from "../env.ts";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { sendNotificationToIterateSlack } from "./integrations/slack/slack-utils.ts";
import { getUserOrganizations } from "./trpc/trpc.ts";
import { getOrCreateAgentStubByName } from "./agent/agents/stub-getters.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "./integrations/stripe/stripe.ts";
import { getOctokitForInstallation } from "./integrations/github/github-utils.ts";

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

  // Perform sequential inserts without opening a new transaction to avoid
  // cross-transaction FK visibility issues with the user record.
  // If the auth layer wraps this in a transaction, these operations will be part of it.
  const organizationResult = await db
    .insert(schema.organization)
    .values({ name: `${user.email}'s Organization` })
    .returning();

  const organization = organizationResult[0];

  if (!organization) {
    throw new Error("Failed to create organization");
  }

  await db.insert(schema.organizationUserMembership).values({
    organizationId: organization.id,
    userId: user.id,
    role: "owner",
  });

  const repo = await createGithubRepoInEstatePool({
    organizationName: organization.name,
    organizationId: organization.id,
  });

  const [estate] = await db
    .insert(schema.estate)
    .values({
      // For now we don't allow people to make more estates or edit theirs and never show this anywhere
      // But in the future users will be able to create multiple estates in one organization
      name: `${user.email}'s primary estate`,
      organizationId: organization.id,
      connectedRepoId: repo.id,
      connectedRepoRef: repo.default_branch,
      connectedRepoPath: "/",
    })
    .returning();

  if (!estate) {
    throw new Error("Failed to create estate");
  }

  const agentName = `${estate.id}-Onboarding`;

  // Update the estate with the onboarding agent name
  await db
    .update(schema.estate)
    .set({
      onboardingAgentName: agentName,
    })
    .where(eq(schema.estate.id, estate.id));

  const result = { organization, estate };

  waitUntil(
    (async () => {
      try {
        await createStripeCustomerAndSubscriptionForOrganization(db, result.organization, user);

        const onboardingAgent = await getOrCreateAgentStubByName("OnboardingAgent", {
          db,
          estateId: estate.id,
          agentInstanceName: agentName,
          reason: "Auto-provisioned OnboardingAgent during estate creation",
        });
        // We need to call some method on the stub, otherwise the agent durable object
        // wouldn't boot up. Obtaining a stub doesn't in itself do anything.
        await onboardingAgent.doNothing();
      } catch (error) {
        logger.error("Failed to create stripe customer and start onboarding agent", error);
      }
    })(),
  );

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
