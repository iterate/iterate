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
  // todo: add `pidnap`/`processes`/`crons`/`tasks`
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
 *   something: "foo",
 * });
 * ```
 */
export function iterateConfig(config: IterateConfig): IterateConfig {
  return config;
}
