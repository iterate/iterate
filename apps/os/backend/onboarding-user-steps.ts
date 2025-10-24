import { eq, and } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";

export type UserOnboardingStepName =
  | "connect_slack"
  | "connect_github"
  | "setup_repo"
  | "confirm_org_name";

/**
 * Update a user onboarding step's status
 */
export async function updateUserStep(
  db: DB,
  estateId: string,
  eventType: UserOnboardingStepName,
  status: "completed" | "skipped",
  metadata?: Record<string, unknown>,
): Promise<void> {
  const onboarding = await db.query.estateOnboarding.findFirst({
    where: eq(schema.estateOnboarding.estateId, estateId),
  });

  if (!onboarding) {
    // Onboarding record doesn't exist (old estate or error)
    return;
  }

  await db
    .update(schema.estateOnboardingEvent)
    .set({
      status,
      completedAt: new Date(),
      metadata: metadata ?? {},
    })
    .where(
      and(
        eq(schema.estateOnboardingEvent.onboardingId, onboarding.id),
        eq(schema.estateOnboardingEvent.eventType, eventType),
      ),
    );
}

/**
 * Get all pending user onboarding steps for an estate
 */
export async function getPendingUserSteps(db: DB, estateId: string) {
  const onboarding = await db.query.estateOnboarding.findFirst({
    where: eq(schema.estateOnboarding.estateId, estateId),
    with: {
      events: {
        where: and(
          eq(schema.estateOnboardingEvent.category, "user"),
          eq(schema.estateOnboardingEvent.status, "pending"),
        ),
      },
    },
  });

  return onboarding?.events ?? [];
}

/**
 * Check if an estate has any blocking onboarding steps
 */
export async function hasBlockingOnboardingSteps(db: DB, estateId: string): Promise<boolean> {
  const pending = await getPendingUserSteps(db, estateId);
  return pending.length > 0;
}

/**
 * Get all user onboarding steps (pending or completed) for an estate
 */
export async function getAllUserSteps(db: DB, estateId: string) {
  const onboarding = await db.query.estateOnboarding.findFirst({
    where: eq(schema.estateOnboarding.estateId, estateId),
    with: {
      events: {
        where: eq(schema.estateOnboardingEvent.category, "user"),
      },
    },
  });

  return onboarding?.events ?? [];
}

/**
 * Get complete onboarding status (system + user)
 */
export async function getOnboardingStatus(db: DB, estateId: string) {
  const onboarding = await db.query.estateOnboarding.findFirst({
    where: eq(schema.estateOnboarding.estateId, estateId),
    with: {
      events: true,
    },
  });

  if (!onboarding) {
    return null;
  }

  const systemEvents = onboarding.events.filter((e) => e.category === "system");
  const userSteps = onboarding.events.filter((e) => e.category === "user");

  return {
    onboarding: {
      id: onboarding.id,
      state: onboarding.state,
      startedAt: onboarding.startedAt,
      completedAt: onboarding.completedAt,
      retryCount: onboarding.retryCount,
      lastError: onboarding.lastError,
    },
    system: {
      events: systemEvents,
      allCompleted: systemEvents.every((e) => e.status === "completed"),
    },
    user: {
      steps: userSteps,
      pendingCount: userSteps.filter((s) => s.status === "pending").length,
      completedCount: userSteps.filter((s) => s.status === "completed").length,
      totalCount: userSteps.length,
    },
  };
}

