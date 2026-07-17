import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate } from "iterate/live-state";
import { LiveState } from "./engine.ts";

/** Subscribe and accumulate every update the engine pushes to this sink. */
function collect<State extends object>(engine: LiveState<State>) {
  const updates: LiveUpdate<State>[] = [];
  const handle = engine.subscribe((update) => void updates.push(update));
  return { updates, handle };
}

describe("LiveState", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers the current state as an immediate snapshot on subscribe", () => {
    const { updates } = collect(new LiveState({ n: 1 }));
    expect(updates).toEqual([{ type: "snapshot", revision: 0, state: { n: 1 } }]);
  });

  it("pushes a debounced patch after setState", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    const { updates } = collect(engine);
    engine.setState({ n: 2 });
    expect(updates).toHaveLength(1); // still debouncing
    vi.advanceTimersByTime(100);
    expect(updates[1]).toEqual({
      type: "patch",
      from: 0,
      to: 1,
      patch: { fields: { n: { set: 2 } } },
    });
  });

  it("coalesces every change in the window into one net patch", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    const { updates } = collect(engine);
    engine.setState({ n: 2 });
    engine.setState({ n: 3 });
    engine.assign({ n: 4 });
    vi.advanceTimersByTime(100);
    expect(updates.slice(1)).toEqual([
      { type: "patch", from: 0, to: 1, patch: { fields: { n: { set: 4 } } } },
    ]);
  });

  it("assign shallow-merges, leaving untouched keys alone", () => {
    const engine = new LiveState({ a: 1, b: 2 }, { debounceMs: 0 });
    const { updates } = collect(engine);
    engine.assign({ b: 3 });
    vi.advanceTimersByTime(0);
    expect(updates[1]).toMatchObject({ patch: { fields: { b: { set: 3 } } } });
    expect(engine.getState()).toEqual({ a: 1, b: 3 });
  });

  it("broadcasts the same patch to every subscriber on one revision line", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    const a = collect(engine);
    const b = collect(engine);
    engine.setState({ n: 2 });
    vi.advanceTimersByTime(100);
    expect(a.updates[1]).toEqual(b.updates[1]);
    expect(a.updates[1]).toMatchObject({ type: "patch", to: 1 });
  });

  it("stays dormant with no subscribers and serves the latest state to a late joiner", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    engine.setState({ n: 2 }); // no subscriber → nothing scheduled
    vi.advanceTimersByTime(100);
    const { updates } = collect(engine);
    expect(updates).toEqual([{ type: "snapshot", revision: 0, state: { n: 2 } }]);
  });

  it("stops delivering after unsubscribe", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    const { updates, handle } = collect(engine);
    expect(engine.hasSubscribers()).toBe(true);
    handle.unsubscribe();
    expect(handle.ping()).toBe(false);
    expect(engine.hasSubscribers()).toBe(false);
    engine.setState({ n: 2 });
    vi.advanceTimersByTime(100);
    expect(updates).toHaveLength(1); // only the initial snapshot
  });

  it("drops a subscriber whose sink throws", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    let calls = 0;
    const handle = engine.subscribe(() => {
      calls += 1;
      throw new Error("dead stub");
    });
    expect(handle.ping()).toBe(false); // snapshot delivery threw → dropped
    engine.setState({ n: 2 });
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1);
  });

  // The retention lifecycle below is the trickiest RPC knowledge in the
  // codebase (see lib/rpc/retain.ts); these cases were originally proven on
  // the deleted processor onStateChange lane and MUST hold here too.

  it("an async delivery rejection drops the subscriber (dead remotes self-prune)", async () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 0 });
    let calls = 0;
    const handle = engine.subscribe(() => {
      calls += 1;
      // The initial snapshot succeeds; every later delivery rejects, the way a
      // dead capnweb/Workers RPC stub rejects every call.
      return calls === 1 ? undefined : Promise.reject(new Error("stub is broken"));
    });
    expect(handle.ping()).toBe(true);
    engine.setState({ n: 2 });
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => expect(handle.ping()).toBe(false)); // rejection observed async
    engine.setState({ n: 3 });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(calls).toBe(2); // nothing delivered after the drop
  });

  it("a transport onRpcBroken signal drops the subscriber", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    let broken: ((error: unknown) => void) | undefined;
    // A plain counter, NOT vi.fn(): the engine disposes a dropped sink, and a
    // vitest mock's built-in Symbol.dispose wipes its call history.
    let calls = 0;
    const sink = Object.assign(
      () => {
        calls += 1;
      },
      {
        onRpcBroken: (handler: (error: unknown) => void) => {
          broken = handler;
        },
      },
    );
    const handle = engine.subscribe(sink);
    expect(handle.ping()).toBe(true);
    broken!(new Error("transport gone"));
    expect(handle.ping()).toBe(false);
    engine.setState({ n: 2 });
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1); // only the initial snapshot
  });

  it("dup()s a retainable sink and disposes the duplicate exactly once on unsubscribe", () => {
    const engine = new LiveState({ n: 1 }, { debounceMs: 100 });
    const dispose = vi.fn();
    const duplicate = Object.assign(vi.fn(), { [Symbol.dispose]: dispose });
    const sink = Object.assign(vi.fn(), { dup: () => duplicate });

    const handle = engine.subscribe(sink);
    expect(duplicate).toHaveBeenCalledTimes(1); // deliveries go to the duplicate
    expect(sink).not.toHaveBeenCalled();

    handle.unsubscribe();
    expect(dispose).toHaveBeenCalledTimes(1);
    handle.unsubscribe(); // idempotent: a second call must not double-dispose
    handle[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
