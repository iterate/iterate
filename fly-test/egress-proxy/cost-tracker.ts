/**
 * Cost tracker using models.dev pricing data.
 *
 * On boot, fetches https://models.dev/api.json and caches model pricing.
 * When AI API responses pass through, parses the usage object from the
 * response body and calculates cost.
 *
 * Supports OpenAI and Anthropic response formats:
 * - OpenAI:  { usage: { prompt_tokens, completion_tokens } }
 * - Anthropic: { usage: { input_tokens, output_tokens } }
 */

import type { Logger } from "./utils.ts";

type ModelPricing = {
  providerId: string;
  modelId: string;
  name: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
};

export type UsageRecord = {
  timestamp: number;
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
};

export type CostSummary = {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  records: UsageRecord[];
  modelsLoaded: number;
};

// Known AI API hostnames → provider mapping
const HOST_TO_PROVIDER: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "api.groq.com": "groq",
  "api.mistral.ai": "mistralai",
  "api.cohere.com": "cohere",
  "api.together.xyz": "togetherai",
  "api.fireworks.ai": "fireworksai",
  "api.deepseek.com": "deepseek",
};

/**
 * models.dev API shape:
 * {
 *   [providerId: string]: {
 *     id: string;
 *     name: string;
 *     models: {
 *       [modelId: string]: {
 *         id: string;
 *         name: string;
 *         cost: { input: number; output: number };  // per 1M tokens
 *         ...
 *       }
 *     }
 *   }
 * }
 */
type ModelsDevProvider = {
  id: string;
  name?: string;
  models?: Record<
    string,
    {
      id: string;
      name?: string;
      cost?: { input?: number; output?: number };
    }
  >;
};

export type CostTracker = {
  /** Try to extract usage from an AI API response body. Returns null if not an AI response. */
  trackResponse: (requestId: string, url: string, responseBody: string) => UsageRecord | null;
  /** Whether the URL belongs to a provider with metered pricing support. */
  isMeteredUrl: (url: string) => boolean;
  /** Get cost summary. */
  getSummary: () => CostSummary;
  /** Number of models loaded from models.dev. */
  modelsLoaded: () => number;
  /** Reset accumulated costs. */
  reset: () => void;
};

export async function createCostTracker(logger: Logger): Promise<CostTracker> {
  // provider:model → pricing
  const pricingMap = new Map<string, ModelPricing>();
  const records: UsageRecord[] = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Fetch models.dev on boot
  try {
    logger.appendLog("MODELS_DEV_FETCH loading pricing from https://models.dev/api.json");
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.appendLog(`MODELS_DEV_FETCH_ERROR status=${response.status}`);
    } else {
      const data = (await response.json()) as Record<string, ModelsDevProvider>;

      for (const [providerId, provider] of Object.entries(data)) {
        if (!provider.models || typeof provider.models !== "object") continue;
        for (const [modelId, model] of Object.entries(provider.models)) {
          const inputCost = model.cost?.input ?? 0;
          const outputCost = model.cost?.output ?? 0;
          if (inputCost > 0 || outputCost > 0) {
            const key = `${providerId}:${modelId}`;
            pricingMap.set(key, {
              providerId,
              modelId,
              name: model.name ?? modelId,
              inputCostPerMillion: inputCost,
              outputCostPerMillion: outputCost,
            });
          }
        }
      }

      logger.appendLog(`MODELS_DEV_LOADED models=${pricingMap.size}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.appendLog(`MODELS_DEV_FETCH_ERROR ${message} (cost tracking disabled)`);
  }

  function getProviderFromUrl(url: string): string | null {
    try {
      const hostname = new URL(url).hostname;
      return HOST_TO_PROVIDER[hostname] ?? null;
    } catch {
      return null;
    }
  }

  function lookupPricing(provider: string, model: string): ModelPricing | null {
    // Try exact match first
    const exact = pricingMap.get(`${provider}:${model}`);
    if (exact) return exact;

    // Try prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
    for (const [key, pricing] of pricingMap) {
      if (key.startsWith(`${provider}:`) && model.startsWith(pricing.modelId)) {
        return pricing;
      }
    }

    return null;
  }

  type UsagePayload = {
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };

  function parseUsage(
    body: string,
  ): { model: string; inputTokens: number; outputTokens: number } | null {
    try {
      const parsed = JSON.parse(body) as UsagePayload;
      if (!parsed.usage || !parsed.model) return null;

      // OpenAI format
      const inputTokens = parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0;
      const outputTokens = parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0;

      if (inputTokens === 0 && outputTokens === 0) return null;

      return {
        model: parsed.model,
        inputTokens,
        outputTokens,
      };
    } catch {
      return null;
    }
  }

  function trackResponse(requestId: string, url: string, responseBody: string): UsageRecord | null {
    const provider = getProviderFromUrl(url);
    if (!provider) return null;

    const usage = parseUsage(responseBody);
    if (!usage) return null;

    const pricing = lookupPricing(provider, usage.model);
    const inputCost = pricing ? (usage.inputTokens * pricing.inputCostPerMillion) / 1_000_000 : 0;
    const outputCost = pricing
      ? (usage.outputTokens * pricing.outputCostPerMillion) / 1_000_000
      : 0;

    const record: UsageRecord = {
      timestamp: Date.now(),
      requestId,
      provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };

    records.push(record);
    totalCost += record.totalCost;
    totalInputTokens += record.inputTokens;
    totalOutputTokens += record.outputTokens;

    return record;
  }

  function getSummary(): CostSummary {
    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      records: [...records],
      modelsLoaded: pricingMap.size,
    };
  }

  return {
    trackResponse,
    isMeteredUrl: (url) => getProviderFromUrl(url) !== null,
    getSummary,
    modelsLoaded: () => pricingMap.size,
    reset: () => {
      records.length = 0;
      totalCost = 0;
      totalInputTokens = 0;
      totalOutputTokens = 0;
    },
  };
}
