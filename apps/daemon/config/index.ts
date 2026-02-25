import type { RestartingProcessEntry } from "pidnap";
export interface IteratePidnapConfig {
  processes?: RestartingProcessEntry[];
}

/**
 * Iterate Config
 *
 * Configuration for the iterate daemon, loaded from iterate.config.ts
 */
export interface IterateConfig {
  /**
   * User-defined pidnap process definitions.
   * These are intended to be reconciled by the daemon into pidnap runtime processes.
   */
  pidnap?: IteratePidnapConfig;
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
