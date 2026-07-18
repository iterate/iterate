import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveStateRpcTarget, type LiveStateRpc } from "../../live-state.ts";
import { LiveState } from "./engine.ts";
import { createLiveStateStore } from "./store.ts";

describe("LiveStateRpcTarget", () => {
  afterEach(() => vi.useRealTimers());

  it("exposes the server engine as a read-only live capability", async () => {
    vi.useFakeTimers();
    const live = new LiveState({ count: 0 }, { debounceMs: 0 });
    const beforeRead = vi.fn();
    class AppSession extends RpcTarget {
      get state(): LiveStateRpcTarget<{ count: number }> {
        return new LiveStateRpcTarget({ live, loadAndRefreshLive: beforeRead });
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

    await expect(app.state.get()).resolves.toEqual({ count: 0 });
    using subscription = await app.state.subscribe((update) => store.apply(update, vi.fn()));

    await vi.waitFor(() => expect(store.getState()).toEqual({ count: 0 }));
    expect(beforeRead).toHaveBeenCalledTimes(2);
    await app.increment();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getState()).toEqual({ count: 1 }));
    await expect(subscription.ping()).resolves.toBe(true);

    // Keep the generic stub type honest: app.state is a capability, not a
    // pass-by-value object that could expose LiveState's mutation methods.
    const state: RpcStub<LiveStateRpc<{ count: number }>> = app.state;
    expect(state).toBeDefined();

    await expect(new LiveStateRpcTarget(live).get()).resolves.toEqual({ count: 1 });
  });
});
