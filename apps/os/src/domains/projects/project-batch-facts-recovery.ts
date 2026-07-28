import { StreamReceiverUnavailableError } from "iterate/processors";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";

export type ProjectBatchFactsIndexResult =
  | { status: "indexed" }
  | { reason: string; status: "unavailable" };

export type ProjectBatchFactsIndexInput = {
  stream: {
    at: string;
    maxOffset: number;
    path: string;
    type: string;
  };
};

function errorIdentity(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Convert a local Project-DO lifecycle interruption into plain RPC data
 * before Workers RPC strips the availability flags. Application failures
 * still reject unchanged.
 */
export async function captureProjectBatchFactsIndex(
  operation: () => Promise<void>,
): Promise<ProjectBatchFactsIndexResult> {
  try {
    await operation();
    return { status: "indexed" };
  } catch (error) {
    if (!isRetryableDurableObjectAvailabilityError(error)) throw error;
    return { reason: errorIdentity(error), status: "unavailable" };
  }
}

type ProjectBatchFactsTarget = {
  /**
   * `void` is the rollout-compatible result from a target still running the
   * pre-result contract. A fulfilled old call indexed the facts successfully.
   */
  indexCommittedBatchFacts: (
    input: ProjectBatchFactsIndexInput,
  ) => PromiseLike<ProjectBatchFactsIndexResult | void> | ProjectBatchFactsIndexResult | void;
};

/**
 * Index one committed delivery on a fresh Project stub. A storage/reset
 * interruption is safe to replay because the streams-index touch and every
 * live-state reducer are idempotent. One immediate re-acquisition absorbs a
 * single rollout transition; a second interruption becomes the delivery
 * spine's explicit receiver-unavailable outcome, so the durable batch backs
 * off and redelivers instead of being mistaken for poison.
 */
export async function indexProjectBatchFactsWithRecovery(input: {
  facts: ProjectBatchFactsIndexInput;
  getProject: () => ProjectBatchFactsTarget;
  projectId: string;
}): Promise<void> {
  let lastReason = "unknown availability failure";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await input.getProject().indexCommittedBatchFacts(input.facts);
      if (result === undefined || result.status === "indexed") return;
      lastReason = result.reason;
    } catch (error) {
      if (!isRetryableDurableObjectAvailabilityError(error)) throw error;
      lastReason = errorIdentity(error);
    }

    if (attempt === 1) {
      console.info("project batch-facts index re-acquiring after Durable Object reset", {
        projectId: input.projectId,
        reason: lastReason,
      });
    }
  }

  throw new StreamReceiverUnavailableError(
    `Project "${input.projectId}" could not index committed batch facts after ` +
      `two availability attempts: ${lastReason}`,
  );
}
