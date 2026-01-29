/**
 * Iterate Config
 *
 * Configuration for the iterate daemon, loaded from iterate.config.ts
 *
 * Model identifiers use the Models.dev format: "provider/model"
 * Examples: "anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.0-flash"
 * See https://models.dev for the full list of supported models.
 */

export interface IterateConfig {
  /**
   * Default model to use for OpenCode sessions.
   * Uses Models.dev format: "provider/model"
   * @example "anthropic/claude-sonnet-4-5"
   */
  defaultModel?: string;
}

/**
 * Parse a Models.dev model string into provider and model ID.
 * @param model - Model string in format "provider/model"
 * @returns Object with providerID and modelID
 */
export function parseModelString(model: string): { providerID: string; modelID: string } {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model format: "${model}". Expected "provider/model" (e.g., "anthropic/claude-sonnet-4-5")`,
    );
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

/**
 * Type-safe identity function for creating iterate config.
 * Use this in your iterate.config.ts for autocomplete and type checking.
 *
 * @example
 * ```ts
 * import { iterateConfig } from "@iterate-com/daemon/config/index.ts";
 *
 * export default iterateConfig({
 *   defaultModel: "anthropic/claude-sonnet-4-5",
 * });
 * ```
 */
export function iterateConfig(config: IterateConfig): IterateConfig {
  return config;
}
