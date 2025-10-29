import { and, asc, eq, isNull } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "./integrations/stripe/stripe.ts";
import { getOrCreateAgentStubByName } from "./agent/agents/stub-getters.ts";

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

async function handleOnboardingAgentWarmup(db: DB, event: typeof schema.systemTasks.$inferSelect) {
  const payload = (event.payload as any) ?? {};
  const estateId: string = (payload.estateId as string) ?? (event.aggregateId as string);
  const onboardingAgentName: string | undefined = payload.onboardingAgentName;

  const est = await db.query.estate.findFirst({ where: eq(schema.estate.id, estateId) });
  if (!est) throw new Error(`Estate ${estateId} not found`);

  const agent = await getOrCreateAgentStubByName("OnboardingAgent", {
    db,
    estateId: est.id,
    agentInstanceName: onboardingAgentName ?? est.onboardingAgentName!,
    reason: "Provisioned via estate onboarding outbox",
  });
  await agent.doNothing();
  await insertEstateOnboardingEvent(db, {
    estateId: est.id,
    organizationId: est.organizationId,
    eventType: "OnboardingAgentWarmed",
    category: "system",
  });
}

export async function processOutboxEvents(db: DB): Promise<{
  processed: number;
  successful: number;
  failed: number;
}> {
  const events = await db
    .select()
    .from(schema.systemTasks)
    .where(isNull(schema.systemTasks.processedAt))
    .orderBy(asc(schema.systemTasks.createdAt))
    .limit(50);

  if (events.length === 0) return { processed: 0, successful: 0, failed: 0 };

  let successful = 0;
  let failed = 0;

  for (const ev of events) {
    try {
      switch (ev.taskType) {
        case "CreateStripeCustomer":
          await handleStripeCustomerCreation(db, ev);
          break;
        case "WarmOnboardingAgent":
          await handleOnboardingAgentWarmup(db, ev);
          break;
        default:
          logger.warn(`Unknown outbox event type: ${ev.taskType} (id=${ev.id})`);
      }
      await db
        .update(schema.systemTasks)
        .set({ processedAt: new Date(), error: null, updatedAt: new Date() })
        .where(eq(schema.systemTasks.id, ev.id as number));
      successful++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.systemTasks)
        .set({ attempts: (ev.attempts ?? 0) + 1, error: message, updatedAt: new Date() })
        .where(eq(schema.systemTasks.id, ev.id as number));
      failed++;
    }
  }

  return { processed: events.length, successful, failed };
}
