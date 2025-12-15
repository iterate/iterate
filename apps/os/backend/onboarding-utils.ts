import type { DB } from "./db/client.ts";

export async function isInstallationOnboardingRequired(
  db: DB,
  installationId: string,
): Promise<boolean> {
  // If we have a completion event, never require onboarding again
  const completion = await db.query.installationOnboardingEvent.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.installationId, installationId), eq(t.eventType, "OnboardingCompleted")),
  });
  return !completion;
}
