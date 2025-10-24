import { and, or, eq, lt } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { logger } from "./tag-logger.ts";
import { processOnboarding } from "./onboarding-processor.ts";

const MAX_RETRY_COUNT = 5;
const RETRY_DELAY_MINUTES = 5;

/**
 * Process all pending or errored onboarding records.
 * This is called by the cron job every 5 minutes.
 */
export async function processPendingOnboardings(db: DB): Promise<{
  processed: number;
  successful: number;
  failed: number;
  skipped: number;
}> {
  const now = new Date();
  const retryThreshold = new Date(now.getTime() - RETRY_DELAY_MINUTES * 60 * 1000);

  // Find onboarding records that need processing:
  // - pending state (never started)
  // - in_progress state that was updated more than 5 minutes ago (likely crashed)
  // - error state with retry count < MAX_RETRY_COUNT and last update > 5 minutes ago
  const pendingOnboardings = await db.query.estateOnboarding.findMany({
    where: or(
      eq(schema.estateOnboarding.state, "pending"),
      and(
        eq(schema.estateOnboarding.state, "in_progress"),
        lt(schema.estateOnboarding.updatedAt, retryThreshold),
      ),
      and(
        eq(schema.estateOnboarding.state, "error"),
        lt(schema.estateOnboarding.retryCount, MAX_RETRY_COUNT),
        lt(schema.estateOnboarding.updatedAt, retryThreshold),
      ),
    ),
    orderBy: (onboarding, { asc }) => [asc(onboarding.createdAt)],
  });

  if (pendingOnboardings.length === 0) {
    return { processed: 0, successful: 0, failed: 0, skipped: 0 };
  }

  logger.info(`Found ${pendingOnboardings.length} onboarding(s) to process`);

  let successful = 0;
  let failed = 0;
  let skipped = 0;

  for (const onboarding of pendingOnboardings) {
    // Skip if we've exceeded retry count
    if (onboarding.retryCount >= MAX_RETRY_COUNT) {
      logger.warn(`Onboarding ${onboarding.id} exceeded max retry count, skipping`);
      skipped++;
      continue;
    }

    try {
      logger.info(
        `Processing onboarding ${onboarding.id} (estate: ${onboarding.estateId}, state: ${onboarding.state}, retryCount: ${onboarding.retryCount})`,
      );
      await processOnboarding(db, onboarding.id);
      successful++;
    } catch (error) {
      logger.error(`Failed to process onboarding ${onboarding.id}:`, error);
      failed++;
      // processOnboarding already updates the error state, so we don't need to do it here
    }
  }

  return {
    processed: pendingOnboardings.length,
    successful,
    failed,
    skipped,
  };
}
