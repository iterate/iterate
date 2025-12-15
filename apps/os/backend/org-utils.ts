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
import { generateSlugFromEmail, generateUniqueSlug } from "./utils/slug-generation.ts";

export const createGithubRepoInInstallationPool = async (metadata: {
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
// not great thing 3: onboardingAgentName shouldn't really be a column on the installation table.
export const getDefaultOnboardingAgentName = (installationId: string) =>
  `${installationId}-Onboarding`;

async function createOrganizationAndInstallationInTransaction(
  tx: DBLike,
  params: {
    organizationName: string;
    ownerUserId: string;
    installationName?: string;
    userEmail: string;
  },
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  installation: typeof schema.installation.$inferSelect;
}> {
  const { organizationName, ownerUserId, installationName, userEmail } = params;

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

  const baseSlug = generateSlugFromEmail(userEmail);
  const slug = await generateUniqueSlug(baseSlug, async (s) => {
    const existing = await tx.query.installation.findFirst({
      where: eq(schema.installation.slug, s),
      columns: { id: true },
    });
    return !!existing;
  });

  const [installation] = await tx
    .insert(schema.installation)
    .values({
      slug,
      name: installationName ?? `${organizationName} Installation`,
      organizationId: organization.id,
    })
    .returning();
  if (!installation) throw new Error("Failed to create installation");

  const onboardingAgentName = getDefaultOnboardingAgentName(installation.id);
  await tx
    .update(schema.installation)
    .set({ onboardingAgentName })
    .where(eq(schema.installation.id, installation.id));

  await tx
    .insert(schema.installationOnboardingEvent)
    .values({
      installationId: installation.id,
      organizationId: organization.id,
      eventType: "InstallationCreated",
      category: "system",
      detail: `Onboarding agent: ${onboardingAgentName}`,
    })
    .onConflictDoNothing();

  return { organization, installation };
}

export async function createOrganizationAndInstallation(
  db: DB,
  params: {
    organizationName: string;
    ownerUserId: string;
    installationName?: string;
    userEmail: string;
  },
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  installation: typeof schema.installation.$inferSelect;
}> {
  return outboxClient.sendTx(db, "installation:created", async (tx) => {
    const result = await createOrganizationAndInstallationInTransaction(tx, params);
    return { payload: { installationId: result.installation.id }, ...result };
  });
}

type DBLike = Pick<DB, "insert" | "update" | "query">;

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

// Function to create organization and installation for new users
export const createUserOrganizationAndInstallation = async (
  db: DB,
  user: {
    id: string;
    name: string;
    email: string;
  },
): Promise<{
  organization: typeof schema.organization.$inferSelect;
  installation?: typeof schema.installation.$inferSelect;
}> => {
  const existingMemberships = await getUserOrganizations(db, user.id);
  if (existingMemberships.length > 0) {
    return {
      organization: existingMemberships[0].organization,
    };
  }

  const provisionalOrgName = `${user.email}'s Organization`;

  const { organization, installation } = await createOrganizationAndInstallation(db, {
    organizationName: provisionalOrgName,
    ownerUserId: user.id,
    installationName: `${user.email}'s primary installation`,
    userEmail: user.email,
  });

  const result = { organization, installation };

  if (env.ITERATE_NOTIFICATION_ESTATE_ID) {
    const userRecord = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, user.id) });
    const shouldSuppress = isTestSignup(user.name, userRecord?.email, organization.name);

    if (!shouldSuppress) {
      waitUntil(
        sendInstallationCreatedNotificationToSlack(result.organization, result.installation).catch(
          (error) => {
            logger.error("Failed to send Slack notification for new installation", error);
          },
        ),
      );
    }
  }
  return result;
};

async function sendInstallationCreatedNotificationToSlack(
  organization: typeof schema.organization.$inferSelect,
  installation: typeof schema.installation.$inferSelect,
) {
  const impersonationUrl = `${env.VITE_PUBLIC_URL}/${installation.slug}`;

  const message = dedent`
    🎉 New user signed up!
    • Installation: ${installation.name}
    • Installation ID: \`${installation.id}\`
    • Slug: \`${installation.slug}\`
    • Organization: ${organization.name}
    • Organization ID: \`${organization.id}\`
    Visit installation: <${impersonationUrl}|Open Installation>
  `;

  await sendNotificationToIterateSlack(message, "#general");
}
