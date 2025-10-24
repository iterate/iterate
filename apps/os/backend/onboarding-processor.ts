import { eq, and } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "./integrations/stripe/stripe.ts";
import { getOrCreateAgentStubByName } from "./agent/agents/stub-getters.ts";

const SYSTEM_ONBOARDING_STEPS = ["stripe_customer", "onboarding_agent"] as const;

/**
 * Update an event's status in the database
 */
type EventType =
  | "stripe_customer"
  | "onboarding_agent"
  | "connect_slack"
  | "connect_github"
  | "setup_repo"
  | "confirm_org_name";

async function updateEventStatus(
  db: DB,
  onboardingId: string,
  eventType: EventType,
  status: "pending" | "in_progress" | "completed" | "error",
  detail?: string,
) {
  await db
    .update(schema.estateOnboardingEvent)
    .set({
      status,
      startedAt: status === "in_progress" ? new Date() : undefined,
      completedAt: status === "completed" || status === "error" ? new Date() : undefined,
      detail,
    })
    .where(
      and(
        eq(schema.estateOnboardingEvent.onboardingId, onboardingId),
        eq(schema.estateOnboardingEvent.eventType, eventType),
      ),
    );
}

/**
 * Get the latest status for a specific event from the database
 */
async function getEventStatus(
  db: DB,
  onboardingId: string,
  eventType: EventType,
): Promise<string | null> {
  const event = await db.query.estateOnboardingEvent.findFirst({
    where: and(
      eq(schema.estateOnboardingEvent.onboardingId, onboardingId),
      eq(schema.estateOnboardingEvent.eventType, eventType),
    ),
  });
  return event?.status ?? null;
}

/**
 * Process the stripe customer creation step
 */
async function processStripeCustomerStep(
  db: DB,
  onboardingId: string,
  organizationId: string,
  ownerUserId: string,
): Promise<void> {
  const stepName = "stripe_customer";

  await updateEventStatus(db, onboardingId, stepName, "in_progress");

  try {
    const organization = await db.query.organization.findFirst({
      where: eq(schema.organization.id, organizationId),
    });
    const user = await db.query.user.findFirst({
      where: eq(schema.user.id, ownerUserId),
    });

    if (!organization) {
      throw new Error(`Organization ${organizationId} not found`);
    }

    if (!user) {
      throw new Error(`User ${ownerUserId} not found`);
    }

    await createStripeCustomerAndSubscriptionForOrganization(db, organization, user);
    await updateEventStatus(db, onboardingId, stepName, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to create stripe customer for onboarding ${onboardingId}:`, error);
    await updateEventStatus(db, onboardingId, stepName, "error", message);
    throw error;
  }
}

/**
 * Process the onboarding agent warm-up step
 */
async function processOnboardingAgentStep(
  db: DB,
  onboardingId: string,
  estateId: string,
): Promise<void> {
  const stepName = "onboarding_agent";

  await updateEventStatus(db, onboardingId, stepName, "in_progress");

  try {
    const estate = await db.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
    });

    if (!estate) {
      throw new Error(`Estate ${estateId} not found`);
    }

    if (!estate.onboardingAgentName) {
      throw new Error(`Estate ${estateId} has no onboarding agent name`);
    }

    const onboardingAgent = await getOrCreateAgentStubByName("OnboardingAgent", {
      db,
      estateId,
      agentInstanceName: estate.onboardingAgentName,
      reason: "Provisioned via estate onboarding processor",
    });

    // We need to call some method on the stub, otherwise the agent durable object
    // wouldn't boot up. Obtaining a stub doesn't in itself do anything.
    await onboardingAgent.doNothing();

    await updateEventStatus(db, onboardingId, stepName, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to warm onboarding agent for onboarding ${onboardingId}:`, error);
    await updateEventStatus(db, onboardingId, stepName, "error", message);
    throw error;
  }
}

/**
 * Process a single onboarding record.
 * This function is idempotent and can be safely retried.
 * It checks the event rows to determine which steps have already completed.
 */
export async function processOnboarding(db: DB, onboardingId: string): Promise<void> {
  const record = await db.query.estateOnboarding.findFirst({
    where: eq(schema.estateOnboarding.id, onboardingId),
  });

  if (!record) {
    logger.error(`Onboarding record ${onboardingId} not found`);
    return;
  }

  // Skip if already completed
  if (record.state === "completed") {
    logger.info(`Onboarding ${onboardingId} already completed, skipping`);
    return;
  }

  // Mark as in_progress if it's pending
  if (record.state === "pending") {
    await db
      .update(schema.estateOnboarding)
      .set({
        state: "in_progress",
        startedAt: new Date(),
      })
      .where(eq(schema.estateOnboarding.id, onboardingId));
  }

  try {
    // Process each system step in order, skipping completed ones
    for (const step of SYSTEM_ONBOARDING_STEPS) {
      const status = await getEventStatus(db, onboardingId, step);

      // Skip if already completed
      if (status === "completed") {
        logger.info(`Onboarding ${onboardingId}: Step ${step} already completed, skipping`);
        continue;
      }

      // Process the step
      logger.info(`Onboarding ${onboardingId}: Processing step ${step}`);

      if (step === "stripe_customer") {
        await processStripeCustomerStep(
          db,
          onboardingId,
          record.organizationId,
          record.ownerUserId,
        );
      } else if (step === "onboarding_agent") {
        await processOnboardingAgentStep(db, onboardingId, record.estateId);
      }
    }

    // If we got here, all system steps completed successfully
    await db
      .update(schema.estateOnboarding)
      .set({
        state: "completed",
        completedAt: new Date(),
        lastError: null,
      })
      .where(eq(schema.estateOnboarding.id, onboardingId));

    logger.info(`Onboarding ${onboardingId} completed successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db
      .update(schema.estateOnboarding)
      .set({
        state: "error",
        lastError: message,
        retryCount: record.retryCount + 1,
      })
      .where(eq(schema.estateOnboarding.id, onboardingId));

    logger.error(`Onboarding ${onboardingId} failed:`, error);
    throw error;
  }
}
