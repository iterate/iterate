/**
 * Iterate Config
 *
 * Configuration for the iterate daemon, loaded from iterate.config.ts
 */

/**
 * Model reference matching OpenCode's internal format.
 * See https://models.dev for available provider and model IDs.
 */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface IterateConfig {
  /**
   * Default model to use for OpenCode sessions.
   * @example { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
   */
  defaultModel?: () => ModelRef;
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
 *   defaultModel: {
 *     providerID: "anthropic",
 *     modelID: "claude-sonnet-4-5",
 *   },
 * });
 * ```
 */
export function iterateConfig(config: IterateConfig): IterateConfig {
  return config;
}
