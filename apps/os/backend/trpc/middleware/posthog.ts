/**
 * Configuration for tracking a specific mutation.
 */
export type MutationTrackingConfig = {
  /** Event name to use in PostHog (defaults to "trpc.{procedure_path}") */
  eventName?: string;
  /**
   * Function to extract properties from the input.
   * Use this to filter sensitive data or select specific fields.
   * Return undefined to skip tracking this particular call.
   */
  extractProperties?: (input: unknown) => Record<string, unknown> | undefined;
  /** Whether to include the full input (default: false for security) */
  includeFullInput?: boolean;
  /** Additional static properties to include */
  staticProperties?: Record<string, unknown>;
};

/**
 * Registry of mutations to track.
 * Key is the full procedure path (e.g., "project.create")
 */
const trackedMutations: Map<string, MutationTrackingConfig> = new Map();

/**
 * Register a mutation to be tracked.
 * Call this at module load time to configure which mutations to track.
 *
 * @example
 * registerTrackedMutation("project.create", {
 *   extractProperties: (input) => ({ projectName: input.name }),
 * });
 */
export function registerTrackedMutation(path: string, config: MutationTrackingConfig = {}): void {
  trackedMutations.set(path, config);
}

/**
 * Get tracking config for a mutation.
 * Returns undefined if the mutation is not registered for tracking.
 */
export function getTrackingConfig(path: string): MutationTrackingConfig | undefined {
  return trackedMutations.get(path);
}
