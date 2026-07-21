import type { StreamEvent } from "iterate/processors";
import { retryIdempotentDurableObjectOperation } from "../streams/stream-unavailable.ts";
import type { AgentCollectionProcessorState } from "./agent-collection-processor-contract.ts";
import type { AgentPath } from "./agent-presence.ts";

type AgentCollectionReads = {
  catchUp(): Promise<void>;
  readonly currentState: AgentCollectionProcessorState;
  waitUntilEvent(input: {
    predicate: (event: StreamEvent) => boolean;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<void>;
};

/** Read-after-create barrier for the singleton agent catalogue. */
export async function waitUntilAgentCreatedInCollection(input: {
  onLifecycleRetry?: (context: { attempt: number; error: unknown; maxAttempts: 2 }) => void;
  path: AgentPath;
  reads: AgentCollectionReads;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  await retryIdempotentDurableObjectOperation({
    operation: async () => {
      const timeoutMs = Math.ceil(deadline - Date.now());
      if (timeoutMs <= 0) {
        throw new Error(`agent collection creation barrier timed out for ${input.path}`);
      }
      await observeAgentCreatedOnce({ ...input, timeoutMs });
    },
    onRetry: input.onLifecycleRetry,
  });
}

async function observeAgentCreatedOnce(input: {
  path: AgentPath;
  reads: AgentCollectionReads;
  timeoutMs: number;
}): Promise<void> {
  const observationAbort = new AbortController();
  // Register before catch-up so creation cannot pass between the durable
  // state check and the future-delivery waiter.
  const observedDelivery = input.reads
    .waitUntilEvent({
      predicate: (event) =>
        event.type === "events.iterate.com/agent/created" &&
        event.source?.crossPostedFrom?.at(-1)?.path === input.path,
      timeoutMs: input.timeoutMs,
      signal: observationAbort.signal,
    })
    .then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  const observedCatchUp = input.reads.catchUp().then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  try {
    const first = await Promise.race([
      observedDelivery.then((observation) => ({ kind: "delivery" as const, observation })),
      observedCatchUp.then((observation) => ({ kind: "catch-up" as const, observation })),
    ]);
    if (first.kind === "delivery") {
      if (first.observation.status === "fulfilled") return;
      throw new Error(`agent collection did not reduce creation of ${input.path}`, {
        cause: first.observation.error,
      });
    }
    if (first.observation.status === "rejected") {
      throw new Error(`agent collection could not catch up while creating ${input.path}`, {
        cause: first.observation.error,
      });
    }
    if (input.reads.currentState.agents[input.path] !== undefined) return;

    const observation = await observedDelivery;
    if (observation.status === "rejected") {
      throw new Error(`agent collection did not reduce creation of ${input.path}`, {
        cause: observation.error,
      });
    }
  } finally {
    observationAbort.abort();
    await observedDelivery;
    void observedCatchUp;
  }
}
