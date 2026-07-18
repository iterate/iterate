import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveState } from "./engine.ts";
import { createLiveStateStore } from "./store.ts";
import { LiveStateRpcTarget, type LiveStateRpc } from "./rpc-target.ts";

describe("LiveStateRpcTarget", () => {
  afterEach(() => vi.useRealTimers());

  it("retains remote callbacks through per-delivery authorization", async () => {
    vi.useFakeTimers();
    const live = new LiveState({ count: 0 }, { debounceMs: 0 });
    let active = true;
    class AppSession extends RpcTarget {
      get state(): LiveStateRpcTarget<{ count: number }> {
        return new LiveStateRpcTarget(live, {
          authorize: () => {
            if (!active) throw new Error("session expired");
          },
        });
      }

      increment(): void {
        live.assign({ count: live.getState().count + 1 });
      }
    }

    const channel = new MessageChannel();
    using _server = newMessagePortRpcSession(channel.port1, new AppSession());
    using app = newMessagePortRpcSession<{
      state: LiveStateRpc<{ count: number }>;
      increment(): void;
    }>(channel.port2);
    const store = createLiveStateStore<{ count: number }>();
    using subscription = await app.state.subscribe((update) => store.apply(update, vi.fn()));

    await vi.waitFor(() => expect(store.getState()).toEqual({ count: 0 }));
    await app.increment();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getState()).toEqual({ count: 1 }));
    await expect(subscription.ping()).resolves.toBe(true);

    active = false;
    live.assign({ count: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toEqual({ count: 1 });
    await expect(subscription.ping()).resolves.toBe(false);

    // Keep the generic stub type honest: app.state is a capability, not a
    // pass-by-value object that could expose LiveState's mutation methods.
    const state: RpcStub<LiveStateRpc<{ count: number }>> = app.state;
    expect(state).toBeDefined();
  });
});
