import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveState } from "./engine.ts";
import type { LiveUpdate } from "./protocol.ts";

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
    handle.unsubscribe();
    expect(handle.ping()).toBe(false);
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
});
