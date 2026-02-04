/**
 * Model Pricing - 2-way transform between Stripe and models.dev
 *
 * Uses tokenlens to get pricing from models.dev catalog.
 * Provides utilities to:
 * - Look up pricing for a model (for cost calculation)
 * - Generate Stripe price key from provider/model
 * - Parse Stripe price key back to provider/model
 *
 * @see https://models.dev for the source catalog
 */

import { defaultCatalog, type ModelCatalog, type ProviderModel } from "tokenlens";

// The catalog is static, just use it directly
const catalog: ModelCatalog = defaultCatalog;

/**
 * Stripe price key format: "provider:model"
 * This is stored in price.metadata.iterate_model_key
 */
export interface StripePriceKey {
  provider: string;
  model: string;
}

/**
 * Parse a Stripe price key back to provider/model.
 */
export function parseStripePriceKey(key: string): StripePriceKey | null {
  const parts = key.split(":");
  if (parts.length !== 2) return null;
  return { provider: parts[0], model: parts[1] };
}

/**
 * Generate a Stripe price key from provider/model.
 */
export function toStripePriceKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Pricing info for a model (in USD per token).
 */
export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** The higher of input/output (used for combined billing) */
  maxCostPerToken: number;
  /** Source model info from tokenlens */
  source?: ProviderModel;
}

/**
 * Default pricing for unknown models.
 * Set conservatively high ($10/1M tokens) to avoid undercharging.
 */
export const DEFAULT_PRICING: ModelPricing = {
  inputCostPerToken: 0.00001, // $10/1M tokens
  outputCostPerToken: 0.00001,
  maxCostPerToken: 0.00001,
};

/**
 * Normalize model ID for lookup.
 * Handles versioned model names like "gpt-4o-2024-08-06" -> "gpt-4o"
 */
function normalizeModelId(model: string): string {
  // Remove date suffixes (e.g., -2024-08-06)
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/**
 * Get pricing for a model from tokenlens catalog.
 *
 * @param provider - Provider ID (e.g., "openai", "anthropic")
 * @param model - Model ID (e.g., "gpt-4o", "claude-3-5-sonnet-20241022")
 */
export function getModelPricing(provider: string, model: string): ModelPricing {
  const providerInfo = catalog[provider];

  if (!providerInfo) {
    return DEFAULT_PRICING;
  }

  // Try exact match first
  let modelInfo: ProviderModel | undefined = providerInfo.models[model];

  // Try normalized (without date suffix)
  if (!modelInfo) {
    const normalized = normalizeModelId(model);
    modelInfo = providerInfo.models[normalized];
  }

  // Try prefix match (for versioned models)
  if (!modelInfo) {
    for (const [id, info] of Object.entries(providerInfo.models)) {
      if (model.startsWith(id)) {
        modelInfo = info;
        break;
      }
    }
  }

  if (!modelInfo?.cost) {
    return DEFAULT_PRICING;
  }

  // models.dev cost is per 1M tokens, convert to per token
  const inputCostPerToken = (modelInfo.cost.input ?? 0) / 1_000_000;
  const outputCostPerToken = (modelInfo.cost.output ?? 0) / 1_000_000;

  return {
    inputCostPerToken,
    outputCostPerToken,
    maxCostPerToken: Math.max(inputCostPerToken, outputCostPerToken),
  };
}

/**
 * Calculate cost in microdollars (1/1,000,000 of a dollar).
 * Using microdollars avoids floating point precision issues.
 *
 * @param provider - Provider ID
 * @param model - Model ID
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 */
export function calculateCostMicrodollars(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getModelPricing(provider, model);
  const inputCost = inputTokens * pricing.inputCostPerToken * 1_000_000;
  const outputCost = outputTokens * pricing.outputCostPerToken * 1_000_000;
  return Math.round(inputCost + outputCost);
}

/**
 * Get all models from the catalog for a provider.
 * Useful for generating Stripe prices.
 */
export function getProviderModels(provider: string): Record<string, ProviderModel> {
  return catalog[provider]?.models ?? {};
}

/**
 * Get supported providers.
 */
export function getSupportedProviders(): string[] {
  return Object.keys(catalog);
}

// Re-export for convenience
export { defaultCatalog } from "tokenlens";
