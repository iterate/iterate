import { and, asc, eq, isNull } from "drizzle-orm";
import { env } from "../env.ts";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "./integrations/stripe/stripe.ts";
import { getOrCreateAgentStubByRoute } from "./agent/agents/stub-getters.ts";
import {
  createGithubRepoInEstatePool,
  type EstateOnboardingEventShape,
  type SystemTaskUnion,
} from "./org-utils.ts";

// Append-only event helper
async function insertEstateOnboardingEvent(
  db: DB,
  params: {
    estateId: string;
    organizationId: string;
    eventType: string;
    category: "system" | "user";
    detail?: string;
  },
) {
  const { estateId, organizationId, eventType, category, detail } = params;
  await db
    .insert(schema.estateOnboardingEvent)
    .values({ estateId, organizationId, eventType, category, detail })
    .onConflictDoNothing();
}

async function handleStripeCustomerCreation(db: DB, event: typeof schema.systemTasks.$inferSelect) {
  const payload = (event.payload as any) ?? {};
  const organizationId: string | undefined = payload.organizationId;
  const estateId: string = (payload.estateId as string) ?? (event.aggregateId as string);

  const organization = await db.query.organization.findFirst({
    where: eq(schema.organization.id, organizationId!),
  });
  if (!organization) throw new Error("Missing org");

  const ownerMembership = await db.query.organizationUserMembership.findFirst({
    where: (m, { eq }) => and(eq(m.organizationId, organization.id), eq(m.role, "owner")),
    with: { user: true },
  });
  const user = ownerMembership?.user ?? undefined;

  if (!user) throw new Error("Missing user to create Stripe customer");

  await createStripeCustomerAndSubscriptionForOrganization(db, organization, user);
  await insertEstateOnboardingEvent(db, {
    estateId,
    organizationId: organization.id,
    eventType: "StripeCustomerCreated",
    category: "system",
  });
}

async function handleOnboardingAgentWarmup(
  db: DB,
  event: Extract<EstateOnboardingEventShape, { taskType: "WarmOnboardingAgent" }>,
) {
  const { estateId, onboardingAgentName } = event.payload;

  const est = await db.query.estate.findFirst({ where: eq(schema.estate.id, estateId) });
  if (!est) throw new Error(`Estate ${estateId} not found`);

  const agent = await getOrCreateAgentStubByRoute("OnboardingAgent", {
    db,
    estateId,
    route: onboardingAgentName,
    reason: `Provisioned via estate onboarding outbox for estate named ${est.name}`,
  });
  await agent.doNothing();
  await insertEstateOnboardingEvent(db, {
    estateId,
    organizationId: est.organizationId,
    eventType: "OnboardingAgentWarmed",
    category: "system",
  });
}

export async function processSystemTasks(db: DB): Promise<{
  processed: number;
  successful: number;
  failed: number;
}> {
  const systemTasks = await db
    .select()
    .from(schema.systemTasks)
    .where(isNull(schema.systemTasks.processedAt))
    .orderBy(asc(schema.systemTasks.createdAt))
    .limit(50);

  if (systemTasks.length === 0) return { processed: 0, successful: 0, failed: 0 };

  let successful = 0;
  let failed = 0;

  for (const task of systemTasks) {
    try {
      const taskType = task.taskType as SystemTaskUnion["taskType"];
      switch (taskType) {
        case "CreateStripeCustomer":
          await handleStripeCustomerCreation(db, task);
          break;
        case "WarmOnboardingAgent":
          await handleOnboardingAgentWarmup(
            db,
            task as Extract<EstateOnboardingEventShape, { taskType: "WarmOnboardingAgent" }>,
          );
          break;
        case "CreateGithubRepo": {
          const estate = await db.query.estate.findFirst({
            where: eq(schema.estate.id, task.aggregateId),
            with: { organization: true },
          });
          if (!estate) throw new Error(`Estate ${task.aggregateId} not found`);
          const activeSource = await db.query.iterateConfigSource.findFirst({
            where: and(
              eq(schema.iterateConfigSource.estateId, estate.id),
              isNull(schema.iterateConfigSource.deactivatedAt),
            ),
          });
          if (activeSource) {
            logger.warn(`Estate ${estate.id} already has an active source, skipping`);
            break;
          }

          const repo = await createGithubRepoInEstatePool({
            organizationName: estate.organization.name,
            organizationId: estate.organizationId,
          });
          await db.transaction(async (tx) => {
            await tx.insert(schema.iterateConfigSource).values({
              estateId: estate.id,
              provider: "github",
              repoId: repo.id,
              branch: repo.default_branch,
              accountId: env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
            });
          });
          break;
        }
        default:
          taskType satisfies never;
          logger.warn(`Unknown system task type: ${task.taskType} (id=${task.id})`);
      }
      await db
        .update(schema.systemTasks)
        .set({ processedAt: new Date(), error: null, updatedAt: new Date() })
        .where(eq(schema.systemTasks.id, task.id as number));
      successful++;
    } catch (err) {
      logger.error(`Error processing system task: ${task.id}`, err);
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.systemTasks)
        .set({ attempts: (task.attempts ?? 0) + 1, error: message, updatedAt: new Date() })
        .where(eq(schema.systemTasks.id, task.id as number));
      failed++;
    }
  }

  return { processed: systemTasks.length, successful, failed };
}
