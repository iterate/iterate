/**
 * Whether workerd rejected a Durable Object stub call because the target
 * incarnation disappeared or was temporarily unavailable, rather than
 * because application code threw. These flags are present only at the direct
 * stub boundary; callers that cross another RPC protocol must define their
 * own serializable error contract.
 */
export function isDurableObjectLifecycleError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const flags = error as {
    durableObjectReset?: unknown;
    overloaded?: unknown;
    retryable?: unknown;
  };
  return flags.durableObjectReset === true || flags.overloaded === true || flags.retryable === true;
}
