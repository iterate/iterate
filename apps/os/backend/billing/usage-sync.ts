/**
 * Usage Sync - Scheduled job to sync Analytics Engine usage to Stripe
 *
 * This module queries Analytics Engine for aggregated usage data and reports
 * it to Stripe for billing. It runs on a cron schedule (every 15 minutes).
 *
 * Analytics Engine schema:
 * - index1: organizationId
 * - blob1: provider
 * - blob2: model
 * - blob3: projectId
 * - blob4: requestId (for dedup)
 * - double1: inputTokens
 * - double2: outputTokens
 * - double3: computeSeconds
 *
 * @see https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
 */

import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../env.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { getStripe } from "../integrations/stripe/stripe.ts";

/** Result row from Analytics Engine query */
interface UsageRow {
  organizationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  computeSeconds: number;
}

/** Analytics Engine SQL API response format */
interface AnalyticsEngineResponse {
  data: Array<{
    organizationId: string;
    provider: string;
    model: string;
    inputTokens: string; // SQL returns numbers as strings
    outputTokens: string;
    computeSeconds: string;
  }>;
  meta: Array<{ name: string; type: string }>;
  rows: number;
  rows_before_limit_at_least: number;
}

const DATASET_NAME = "egress_usage";

/**
 * Query Analytics Engine SQL API for aggregated usage data.
 * @see https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
 */
async function queryAnalyticsEngine(
  accountId: string,
  apiToken: string,
  query: string,
): Promise<AnalyticsEngineResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "text/plain",
    },
    body: query,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analytics Engine query failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<AnalyticsEngineResponse>;
}

/**
 * Get the Stripe customer ID for an organization.
 * Returns null if the organization has no billing account.
 */
async function getStripeCustomerForOrg(organizationId: string): Promise<string | null> {
  const db = getDb();
  const account = await db.query.billingAccount.findFirst({
    where: eq(schema.billingAccount.organizationId, organizationId),
  });
  return account?.stripeCustomerId ?? null;
}

/**
 * Report usage to Stripe for a single organization.
 *
 * Per docs/passthru.md spec:
 * - Single "ai_usage" meter with dimensions (provider, model)
 * - Events include dimension values for routing to correct rate
 * - Combined input+output tokens as the value
 *
 * The meter event payload includes:
 * - stripe_customer_id: maps to Stripe customer
 * - value: total tokens (input + output combined)
 * - provider: dimension for rate card routing
 * - model: dimension for rate card routing
 */
async function reportOrgUsageToStripe(
  stripeCustomerId: string,
  usage: UsageRow,
  syncId: string,
): Promise<void> {
  const stripe = getStripe();

  // Report AI usage (tokens) with dimensions
  // Per spec: combine input+output tokens, include provider/model dimensions
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (totalTokens > 0) {
    await stripe.v2.billing.meterEvents.create({
      event_name: "ai_usage",
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(totalTokens),
        // Dimensions for rate card routing
        provider: usage.provider,
        model: usage.model,
      },
      // Idempotency key per spec: org-model-interval
      identifier: `${syncId}-${usage.organizationId}-${usage.provider}-${usage.model}`,
    });
  }

  // Compute seconds (for Replicate) - also goes to ai_usage meter
  // but with different dimension values
  if (usage.computeSeconds > 0) {
    await stripe.v2.billing.meterEvents.create({
      event_name: "ai_usage",
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(Math.ceil(usage.computeSeconds)),
        provider: usage.provider,
        model: `${usage.model}:compute`, // Distinguish compute from tokens
      },
      identifier: `${syncId}-${usage.organizationId}-${usage.provider}-${usage.model}-compute`,
    });
  }
}

/**
 * Main sync function - queries Analytics Engine and reports to Stripe.
 * Called by the scheduled handler every 15 minutes.
 */
export async function syncUsageToStripe(env: CloudflareEnv): Promise<void> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    logger.warn("CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not available, skipping sync");
    return;
  }

  const syncId = `sync-${Date.now()}`;

  try {
    logger.info("Starting usage sync", { syncId });

    // Query last 15 minutes of usage data, grouped by org/provider/model
    // Using SUM(_sample_interval * value) to account for sampling
    // @see https://developers.cloudflare.com/analytics/analytics-engine/sql-api/#sampling
    const query = `
      SELECT
        index1 AS organizationId,
        blob1 AS provider,
        blob2 AS model,
        SUM(_sample_interval * double1) AS inputTokens,
        SUM(_sample_interval * double2) AS outputTokens,
        SUM(_sample_interval * double3) AS computeSeconds
      FROM ${DATASET_NAME}
      WHERE timestamp > NOW() - INTERVAL '15' MINUTE
      GROUP BY index1, blob1, blob2
      FORMAT JSON
    `;

    const result = await queryAnalyticsEngine(accountId, apiToken, query);

    logger.info("Analytics Engine query completed", {
      syncId,
      rowCount: result.rows,
    });

    if (result.rows === 0) {
      logger.info("No usage data to sync", { syncId });
      return;
    }

    // Process each row and report to Stripe
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const row of result.data) {
      const usage: UsageRow = {
        organizationId: row.organizationId,
        provider: row.provider,
        model: row.model,
        inputTokens: Math.round(parseFloat(row.inputTokens) || 0),
        outputTokens: Math.round(parseFloat(row.outputTokens) || 0),
        computeSeconds: parseFloat(row.computeSeconds) || 0,
      };

      // Skip if no actual usage
      if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.computeSeconds === 0) {
        skipCount++;
        continue;
      }

      // Get Stripe customer for this org
      const stripeCustomerId = await getStripeCustomerForOrg(usage.organizationId);

      if (!stripeCustomerId) {
        logger.debug("No Stripe customer for org, skipping", {
          organizationId: usage.organizationId,
        });
        skipCount++;
        continue;
      }

      try {
        await reportOrgUsageToStripe(stripeCustomerId, usage, syncId);
        successCount++;

        logger.debug("Reported usage to Stripe", {
          organizationId: usage.organizationId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          computeSeconds: usage.computeSeconds,
        });
      } catch (err) {
        errorCount++;
        logger.error("Failed to report usage to Stripe", {
          organizationId: usage.organizationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Usage sync completed", {
      syncId,
      successCount,
      skipCount,
      errorCount,
      totalRows: result.rows,
    });
  } catch (err) {
    logger.error("Usage sync failed", {
      syncId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
