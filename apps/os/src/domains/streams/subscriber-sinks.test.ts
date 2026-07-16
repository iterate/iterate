import { describe, expect, it, vi } from "vitest";
import type { StreamPushEventBatch } from "./rpc-types.ts";
import { createSubscriberDial } from "./subscriber-sinks.ts";

const batch: StreamPushEventBatch = {
  projectId: "prj_test",
  path: "/test",
  events: [],
  streamMaxOffset: 3,
  subscriptionKey: "receiver",
  deliveryId: "receiver:3-3",
  attempt: 1,
  configuredEvent: {
    type: "events.iterate.com/stream/subscription-configured",
    offset: 2,
    createdAt: "2026-07-16T00:00:00.000Z",
    path: "/test",
    payload: {},
  },
};

describe("createSubscriberDial", () => {
  it("uses a fresh local authority root for each push delivery", async () => {
    const received: StreamPushEventBatch[] = [];
    const authorityRoots = vi.fn(() => {
      return {
        receive: async (input: StreamPushEventBatch) => {
          received.push(input);
        },
      };
    });
    const loopback = vi.fn(() => {
      throw new Error("push delivery must not dial the ItxEntrypoint loopback");
    });
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: { ItxEntrypoint: loopback },
      authorityRoot: authorityRoots,
      onDurableDeliveryError: vi.fn(),
    });

    await dial.push(["receive"], batch);
    expect(received).toEqual([batch]);
    expect(authorityRoots).toHaveBeenCalledTimes(1);
    expect(loopback).not.toHaveBeenCalled();

    await dial.push(["receive"], batch);
    expect(received).toEqual([batch, batch]);
    expect(authorityRoots).toHaveBeenCalledTimes(2);
  });
});
