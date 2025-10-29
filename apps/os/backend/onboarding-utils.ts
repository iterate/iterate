import type { DB } from "./db/client.ts";

export async function isEstateOnboardingRequired(db: DB, estateId: string): Promise<boolean> {
  // If we have a completion event, never require onboarding again
  const completion = await db.query.estateOnboardingEvent.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.estateId, estateId), eq(t.eventType, "OnboardingCompleted")),
  });
  return !completion;
}
