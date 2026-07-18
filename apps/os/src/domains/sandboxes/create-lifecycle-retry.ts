import { isDurableObjectLifecycleError } from "../streams/stream-unavailable.ts";

/** A deploy/eviction reset should normally clear on the next DO incarnation. */
export const SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS = 3;

/**
 * Run one strict sandbox create, then bounded resumptions only when workerd
 * explicitly classifies the rejection as a Durable Object lifecycle failure.
 *
 * The two callbacks are deliberately different. Retrying the strict create
 * after a lost success acknowledgement would misclassify the now-existing
 * sandbox as a duplicate. The resume callback instead heals a pending birth
 * or returns the already-completed result from the same catalogue claim.
 */
export async function createSandboxWithLifecycleRetry<Result>(args: {
  create: () => Promise<Result>;
  onRetry?: (context: { attempt: number; error: unknown; maxAttempts: number }) => void;
  resume: () => Promise<Result>;
}): Promise<Result> {
  for (let attempt = 1; attempt <= SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await (attempt === 1 ? args.create() : args.resume());
    } catch (error) {
      if (
        attempt === SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS ||
        !isDurableObjectLifecycleError(error)
      ) {
        throw error;
      }
      args.onRetry?.({
        attempt,
        error,
        maxAttempts: SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS,
      });
    }
  }
  throw new Error("sandbox create exhausted its bounded lifecycle retry");
}
