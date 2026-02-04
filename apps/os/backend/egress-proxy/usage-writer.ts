/**
 * Usage Writer for Analytics Engine
 *
 * Writes usage data points to Cloudflare Analytics Engine for aggregation.
 * Data is structured for efficient querying by organization, provider, and model.
 *
 * Analytics Engine schema:
 * - index1: organizationId (for fast GROUP BY org)
 * - blob1: provider (e.g., "openai", "anthropic")
 * - blob2: model (e.g., "gpt-4o", "claude-3-5-sonnet")
 * - blob3: projectId
 * - blob4: requestId (for deduplication)
 * - double1: inputTokens
 * - double2: outputTokens
 * - double3: computeSeconds (for Replicate)
 */

import type { ExtractedUsage } from "./usage-extractors/types.ts";
import { logger } from "../tag-logger.ts";

/** Context for the usage event */
export interface UsageContext {
  organizationId: string;
  projectId: string;
}

/**
 * Analytics Engine dataset interface.
 * This matches the Cloudflare Workers Analytics Engine binding.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/**
 * Write a usage data point to Analytics Engine.
 * Called after extracting usage from an API response.
 */
export function writeUsageDataPoint(
  analytics: AnalyticsEngineDataset | undefined,
  usage: ExtractedUsage,
  context: UsageContext,
): void {
  if (!analytics) {
    logger.debug("Analytics Engine not available, skipping usage write");
    return;
  }

  try {
    analytics.writeDataPoint({
      indexes: [context.organizationId],
      blobs: [usage.provider, usage.model, context.projectId, usage.requestId],
      doubles: [usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.computeSeconds ?? 0],
    });

    logger.debug("Wrote usage data point", {
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      computeSeconds: usage.computeSeconds,
      organizationId: context.organizationId,
    });
  } catch (err) {
    logger.error("Failed to write usage data point", {
      error: err instanceof Error ? err.message : String(err),
      provider: usage.provider,
      model: usage.model,
    });
  }
}
