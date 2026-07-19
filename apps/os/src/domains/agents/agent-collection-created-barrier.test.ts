import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { AgentCollectionProcessorContract } from "./agent-collection-processor-contract.ts";
import { waitUntilAgentCreatedInCollection } from "./agent-collection-created-barrier.ts";

const path = "/agents/test-agent";

function lifecycleReset() {
  return Object.assign(new Error("Durable Object reset because its code was updated."), {
    durableObjectReset: true,
  });
}

function abortableDelivery() {
  return vi.fn(
    async (input: {
      predicate: (event: StreamEvent) => boolean;
      signal: AbortSignal;
      timeoutMs: number;
    }) => {
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    },
  );
}

describe("waitUntilAgentCreatedInCollection", () => {
  it("retries a nested Stream lifecycle reset and observes the fresh incarnation", async () => {
    const state = AgentCollectionProcessorContract.stateSchema.parse({});
    const catchUp = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(lifecycleReset())
      .mockImplementationOnce(async () => {
        state.agents[path] = { path } as (typeof state.agents)[string];
      });
    const waitUntilEvent = abortableDelivery();
    const onLifecycleRetry = vi.fn();

    await expect(
      waitUntilAgentCreatedInCollection({
        onLifecycleRetry,
        path,
        reads: { catchUp, currentState: state, waitUntilEvent },
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();

    expect(catchUp).toHaveBeenCalledTimes(2);
    expect(waitUntilEvent).toHaveBeenCalledTimes(2);
    expect(onLifecycleRetry).toHaveBeenCalledOnce();
    expect(onLifecycleRetry).toHaveBeenCalledWith({
      attempt: 1,
      error: expect.objectContaining({
        message: `agent collection could not catch up while creating ${path}`,
      }),
      maxAttempts: 3,
    });
  });

  it("does not retry an application catch-up failure", async () => {
    const applicationError = new Error("invalid processor state");
    const catchUp = vi.fn(async () => {
      throw applicationError;
    });
    const waitUntilEvent = abortableDelivery();
    const onLifecycleRetry = vi.fn();

    await expect(
      waitUntilAgentCreatedInCollection({
        onLifecycleRetry,
        path,
        reads: {
          catchUp,
          currentState: AgentCollectionProcessorContract.stateSchema.parse({}),
          waitUntilEvent,
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      cause: applicationError,
      message: `agent collection could not catch up while creating ${path}`,
    });
    expect(catchUp).toHaveBeenCalledOnce();
    expect(onLifecycleRetry).not.toHaveBeenCalled();
  });
});
