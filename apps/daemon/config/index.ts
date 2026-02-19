/**
 * Iterate Config
 *
 * Configuration for the iterate daemon, loaded from iterate.config.ts
 */

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
