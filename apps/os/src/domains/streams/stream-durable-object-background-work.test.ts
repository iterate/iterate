import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProcessorContract } from "./core-processor-contract.ts";
import {
  assertSubscriptionCursorSetAllowed,
  settleStreamCoreBackgroundWork,
} from "./stream-durable-object.ts";

afterEach(() => vi.restoreAllMocks());

describe("settleStreamCoreBackgroundWork", () => {
  it("settles a deployment reset as an observed lifecycle interruption", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(reset)),
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      "stream core background work interrupted by durable object lifecycle",
      { message: reset.message },
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("reports an application failure exactly once while settling the waitUntil promise", async () => {
    const failure = new Error("ancestor append rejected");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(failure)),
    ).resolves.toBeUndefined();

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("stream core background work failed", failure);
  });

  it("also observes a synchronous application failure", async () => {
    const failure = new Error("background work did not start");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("stream core background work failed", failure);
  });
});

describe("assertSubscriptionCursorSetAllowed", () => {
  const cursorSet = {
    type: "events.iterate.com/stream/subscription-cursor-set",
    payload: { subscriptionKey: "k", afterOffset: 0 },
  } as const;

  function stateFor(mode: "wake" | "push") {
    return CoreProcessorContract.stateSchema.parse({
      configuredSubscribersByKey: {
        k: {
          latestConfiguredEvent: {
            offset: 1,
            createdAt: "2026-07-17T00:00:00.000Z",
            type: "events.iterate.com/stream/subscription-configured",
            payload: {
              subscriptionKey: "k",
              delivery:
                mode === "wake"
                  ? {
                      mode,
                      expression: ["agents", ["get", "/a"], "processor", "wakeStreamSubscriber"],
                    }
                  : { mode, expression: ["processEventBatch"] },
            },
          },
        },
      },
    });
  }

  it("rejects seeks for wake subscriptions because their processor checkpoint owns replay", () => {
    expect(() => assertSubscriptionCursorSetAllowed(stateFor("wake"), cursorSet)).toThrow(
      'subscription-cursor-set does not apply to wake subscription "k"',
    );
  });

  it("allows seeks for stream-cursor-owned push subscriptions", () => {
    expect(() => assertSubscriptionCursorSetAllowed(stateFor("push"), cursorSet)).not.toThrow();
  });

  it("rejects seeks for unknown subscriptions", () => {
    const state = CoreProcessorContract.stateSchema.parse({});
    expect(() => assertSubscriptionCursorSetAllowed(state, cursorSet)).toThrow(
      'unknown subscription "k"',
    );
  });
});
