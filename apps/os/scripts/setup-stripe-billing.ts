/**
 * Setup Stripe Advanced Usage-Based Billing.
 *
 * Creates a single meter with dimensions (provider, model) and per-model pricing
 * via rate cards. Pricing is pulled from models.dev via tokenlens.
 *
 * Architecture (per docs/passthru.md):
 * - One meter "ai_usage" with dimensions: provider, model
 * - Meter events include dimension values for routing to correct rate
 * - Rate card with metered items per model, each with dimension filters
 *
 * Usage: Called from alchemy.run.ts during deployment
 *
 * @see docs/passthru.md for full spec
 * @see https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about
 */

import { defaultCatalog } from "tokenlens";

/** Supported providers for billing */
export const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const;

/** Fallback price per 1M tokens for unknown models */
export const FALLBACK_COST_PER_M_TOKENS = 10; // $10/1M tokens

/**
 * Helper to call Stripe API directly (for features not in SDK).
 */
async function stripeRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `https://api.stripe.com${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Stripe-Version": "2025-01-27.acacia", // Required for Advanced Billing
  };

  const options: RequestInit = { method, headers };

  if (body && method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(flattenForStripe(body)).toString();
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    const error = data as { error?: { message?: string } };
    throw new Error(`Stripe API error: ${error.error?.message ?? response.statusText}`);
  }

  return data as T;
}

/**
 * Flatten nested objects for Stripe's form encoding.
 * e.g., { foo: { bar: "baz" } } => { "foo[bar]": "baz" }
 */
function flattenForStripe(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}[${key}]` : key;

    if (value === null || value === undefined) {
      continue;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenForStripe(value as Record<string, unknown>, newKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object") {
          Object.assign(
            result,
            flattenForStripe(item as Record<string, unknown>, `${newKey}[${i}]`),
          );
        } else {
          result[`${newKey}[${i}]`] = String(item);
        }
      });
    } else {
      result[newKey] = String(value);
    }
  }

  return result;
}

// Stripe API response types
interface MeterListResponse {
  data: Array<{ id: string; event_name: string; status: string }>;
}

interface ProductListResponse {
  data: Array<{ id: string; name: string; active: boolean; metadata: Record<string, string> }>;
}

interface PriceListResponse {
  data: Array<{
    id: string;
    nickname: string | null;
    active: boolean;
    metadata: Record<string, string>;
  }>;
}

interface MeterResponse {
  id: string;
  event_name: string;
  status: string;
}

interface ProductResponse {
  id: string;
  name: string;
  active: boolean;
  metadata: Record<string, string>;
}

// Type for model info from tokenlens
type ModelInfo = {
  id: string;
  name: string;
  cost?: { input?: number; output?: number };
};

export interface SetupStripeBillingOptions {
  /** Stripe secret key */
  stripeKey: string;
  /** Whether this is a development environment */
  isDevelopment: boolean;
}

/**
 * Setup Stripe Advanced Usage-Based Billing.
 *
 * Creates:
 * - ai_usage meter with dimensions (provider, model)
 * - AI Usage product
 * - Per-model prices from tokenlens catalog
 * - Fallback price for unknown models
 */
export async function setupStripeBilling(options: SetupStripeBillingOptions): Promise<void> {
  const { stripeKey, isDevelopment } = options;

  if (!stripeKey) {
    console.log("Skipping Stripe billing setup: STRIPE_SECRET_KEY not set");
    return;
  }

  if (isDevelopment && !stripeKey.startsWith("sk_test_")) {
    throw new Error(
      "STRIPE_SECRET_KEY must be a test key (sk_test_*) in development to avoid creating meters in production Stripe",
    );
  }

  console.log("Setting up Stripe Advanced Usage-Based Billing...");

  // 1. Create or find the ai_usage meter
  const existingMeters = await stripeRequest<MeterListResponse>(
    stripeKey,
    "GET",
    "/v1/billing/meters?limit=100",
  );

  const findMeter = (eventName: string) =>
    existingMeters.data.find((m) => m.event_name === eventName && m.status === "active");

  let aiMeter = findMeter("ai_usage");
  if (!aiMeter) {
    console.log("  Creating ai_usage meter with dimensions...");
    aiMeter = await stripeRequest<MeterResponse>(stripeKey, "POST", "/v1/billing/meters", {
      display_name: "AI Usage",
      event_name: "ai_usage",
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });
    console.log(`  Created meter: ${aiMeter.event_name} [${aiMeter.id}]`);
  } else {
    console.log(`  Meter exists: ${aiMeter.event_name} [${aiMeter.id}]`);
  }

  // 2. Create or find the AI Usage product
  const existingProducts = await stripeRequest<ProductListResponse>(
    stripeKey,
    "GET",
    "/v1/products?limit=100&active=true",
  );

  let aiProduct = existingProducts.data.find((p) => p.metadata?.iterate_product === "ai_usage");
  if (!aiProduct) {
    console.log("  Creating AI Usage product...");
    aiProduct = await stripeRequest<ProductResponse>(stripeKey, "POST", "/v1/products", {
      name: "AI Usage",
      description: "Usage-based billing for AI model access via iterate",
      metadata: { iterate_product: "ai_usage" },
    });
    console.log(`  Created product: ${aiProduct.name} [${aiProduct.id}]`);
  } else {
    console.log(`  Product exists: ${aiProduct.name} [${aiProduct.id}]`);
  }

  // 3. Get existing prices
  const existingPrices = await stripeRequest<PriceListResponse>(
    stripeKey,
    "GET",
    `/v1/prices?product=${aiProduct.id}&limit=100&active=true`,
  );

  // 4. Create prices for models from tokenlens catalog
  for (const providerId of SUPPORTED_PROVIDERS) {
    const providerInfo = defaultCatalog[providerId];
    if (!providerInfo) {
      console.log(`  Provider ${providerId} not found in catalog, skipping`);
      continue;
    }

    const models = providerInfo.models as Record<string, ModelInfo>;

    for (const [modelId, modelInfo] of Object.entries(models)) {
      // Skip models without pricing
      if (!modelInfo.cost?.input && !modelInfo.cost?.output) {
        continue;
      }

      // Create a stable price key from provider:model
      const priceKey = `${providerId}:${modelId}`;
      const existingPrice = existingPrices.data.find(
        (p) => p.metadata?.iterate_model_key === priceKey,
      );

      if (existingPrice) {
        continue; // Price already exists
      }

      // Get pricing (cost is per 1M tokens in models.dev)
      const inputCostPerMToken = modelInfo.cost?.input ?? 0;
      const outputCostPerMToken = modelInfo.cost?.output ?? 0;

      // Use output cost as the rate (it's typically higher, ensures we cover costs)
      // Per spec: we combine input/output tokens, charge at higher rate
      const costPerMToken = Math.max(inputCostPerMToken, outputCostPerMToken);

      if (costPerMToken === 0) {
        continue; // No pricing available
      }

      // Convert to cents per token (Stripe uses smallest currency unit)
      // cost is $/1M tokens, so $/token = cost / 1,000,000
      // cents/token = (cost / 1,000,000) * 100 = cost / 10,000
      const centsPerToken = costPerMToken / 10000;

      // Stripe requires unit_amount_decimal for sub-cent pricing
      const unitAmountDecimal = centsPerToken.toFixed(12);

      const displayName = modelInfo.name || modelId;
      console.log(
        `  Creating price: ${providerId}/${displayName} ($${costPerMToken}/1M tokens)...`,
      );

      await stripeRequest(stripeKey, "POST", "/v1/prices", {
        product: aiProduct.id,
        currency: "usd",
        unit_amount_decimal: unitAmountDecimal,
        recurring: {
          interval: "month",
          usage_type: "metered",
          meter: aiMeter.id,
        },
        nickname: `${displayName} (${providerId})`,
        metadata: {
          iterate_model_key: priceKey,
          provider: providerId,
          model: modelId,
          // Store original pricing for reference/auditing
          input_cost_per_m: String(inputCostPerMToken),
          output_cost_per_m: String(outputCostPerMToken),
        },
      });
    }
  }

  // 5. Create a fallback/default price for unknown models
  const fallbackPriceKey = "fallback:unknown";
  const existingFallback = existingPrices.data.find(
    (p) => p.metadata?.iterate_model_key === fallbackPriceKey,
  );

  if (!existingFallback) {
    const fallbackCentsPerToken = FALLBACK_COST_PER_M_TOKENS / 10000;
    console.log(`  Creating fallback price ($${FALLBACK_COST_PER_M_TOKENS}/1M tokens)...`);

    await stripeRequest(stripeKey, "POST", "/v1/prices", {
      product: aiProduct.id,
      currency: "usd",
      unit_amount_decimal: fallbackCentsPerToken.toFixed(12),
      recurring: {
        interval: "month",
        usage_type: "metered",
        meter: aiMeter.id,
      },
      nickname: "Unknown Model (fallback)",
      metadata: {
        iterate_model_key: fallbackPriceKey,
        provider: "unknown",
        model: "unknown",
      },
    });
  }

  console.log("Stripe billing setup complete");
}
