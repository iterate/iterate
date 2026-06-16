// Regression tests for streams review finding M1: broken delivery
// connections were never detected. Two halves:
//
// 1. `onRpcBroken` was guarded by `Object.hasOwn`, which is always false for
//    Cap'n Web proxy stubs (they intercept the property without exposing an own
//    descriptor), so the break callback was never wired.
// 2. The retained delivery callback disposed the remote call result without
//    observing it, so a delivery rejection (the only break signal native
//    Workers RPC stubs give us) was swallowed and the dead connection stayed
//    in the stream's connection map forever.

import { describe, expect, it, vi } from "vitest";
import type { ProcessEventBatch } from "../types.ts";
import { CoreProcessorContract } from "../processors/core/contract.ts";
import { retainProcessEventBatch } from "./rpc-lifecycle.ts";

const batch = {
  projectId: "test",
  path: "/p",
  events: [],
  streamMaxOffset: 0,
  state: CoreProcessorContract.stateSchema.parse(CoreProcessorContract.initialState),
};

describe("retainProcessEventBatch onRpcBroken wiring (M1)", () => {
  it("wires onRpcBroken exposed only through a proxy get trap (Cap'n Web stub shape)", () => {
    const registered: ((error: unknown) => void)[] = [];
    // Cap'n Web stubs are proxies: `typeof stub.onRpcBroken === "function"`
    // but `Object.hasOwn(stub, "onRpcBroken")` is false.
    const stub = new Proxy((() => undefined) as unknown as ProcessEventBatch as object, {
      get(target, property, receiver) {
        if (property === "onRpcBroken") {
          return (callback: (error: unknown) => void) => void registered.push(callback);
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor() {
        return undefined;
      },
    }) as ProcessEventBatch;
    expect(Object.hasOwn(stub, "onRpcBroken")).toBe(false);

    const retained = retainProcessEventBatch(stub);
    const onBroken = vi.fn();
    retained.onRpcBroken?.(onBroken);

    expect(registered).toHaveLength(1);
    registered[0]!(new Error("stub broken"));
    expect(onBroken).toHaveBeenCalledWith(new Error("stub broken"));
  });

  it("survives a pipelined fake onRpcBroken that rejects at call time (native RPC stub shape)", async () => {
    // Property access on a Workers RPC stub can fabricate a method that only
    // fails asynchronously when called. Registration must not throw and must
    // not produce an unhandled rejection.
    const fake = Object.assign((() => undefined) as unknown as ProcessEventBatch as object, {
      onRpcBroken: () => Promise.reject(new Error("no such method")),
    }) as ProcessEventBatch;

    const retained = retainProcessEventBatch(fake);
    expect(() => retained.onRpcBroken?.(() => undefined)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("retainProcessEventBatch delivery rejection (M1)", () => {
  it("reports a rejected delivery through onDeliveryError", async () => {
    const failure = new Error("Durable Object reset because its code was updated");

    const onDeliveryError = vi.fn();
    const retained = retainProcessEventBatch(() => Promise.reject(failure), { onDeliveryError });
    retained(batch);

    await vi.waitFor(() => expect(onDeliveryError).toHaveBeenCalledWith(failure));
  });

  it("does not report successful deliveries and disposes the settled result", async () => {
    const disposed = vi.fn();
    const result = Object.assign(Promise.resolve(undefined), {
      [Symbol.dispose]: disposed,
    });

    const onDeliveryError = vi.fn();
    const retained = retainProcessEventBatch(() => result as unknown as Promise<void>, {
      onDeliveryError,
    });
    retained(batch);

    await vi.waitFor(() => expect(disposed).toHaveBeenCalled());
    expect(onDeliveryError).not.toHaveBeenCalled();
  });

  it("disposes immediately without pulling the result when no onDeliveryError is given", () => {
    // The zero-return-traffic fast path for inbound/browser connections:
    // attaching .then to a Cap'n Web promise would make the remote send a
    // resolve frame per delivery, so without a handler the result must be
    // disposed synchronously, never observed.
    const disposed = vi.fn();
    const then = vi.fn();
    const result = { then, [Symbol.dispose]: disposed };

    const retained = retainProcessEventBatch(() => result as unknown as Promise<void>);
    retained(batch);

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(then).not.toHaveBeenCalled();
  });

  it("handles synchronous (non-thenable) callback results", () => {
    const calls: unknown[] = [];

    const retained = retainProcessEventBatch((delivered) => void calls.push(delivered), {
      onDeliveryError: vi.fn(),
    });
    expect(() => retained(batch)).not.toThrow();
    expect(calls).toEqual([batch]);
  });
});
