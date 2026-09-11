import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate } from "./protocol.ts";
import { LiveState } from "./engine.ts";
import { createLiveStateStore } from "./store.ts";

/** Subscribe and accumulate every update the engine pushes to this sink. */
function collect<State extends object>(engine: LiveState<State>) {
  const updates: LiveUpdate<State>[] = [];
  const handle = engine.subscribe((update) => void updates.push(update));
  return { updates, handle };
}

describe("LiveState", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("negotiates positional patches while existing clients receive array replacements", () => {
    const engine = new LiveState({ rows: [{ n: 1 }, { n: 2 }] }, { debounceMs: 0 });
    const old = collect(engine);
    const updates: LiveUpdate[] = [];
    engine.subscribe((update) => void updates.push(update), { patchVersion: 2 });
    engine.setState({ rows: [{ n: 1 }, { n: 3 }] });
    vi.advanceTimersByTime(0);
    expect(old.updates[1]).toMatchObject({
      patch: { fields: { rows: { set: [{ n: 1 }, { n: 3 }] } } },
    });
    expect(updates[1]).toMatchObject({
      patch: { fields: { rows: { array: { items: [[1, { fields: { n: { set: 3 } } }]] } } } },
    });
  });

  it("serves one transient delta and re-seeds late readers or new incarnations", () => {
    const engine = new LiveState({ n: 0 });
    const seed = engine.readSince();
    const cursor = { epoch: seed.epoch, revision: 0 };
    engine.assign({ n: 1 });
    const changed = engine.readSince(cursor);
    expect(changed.update).toMatchObject({ type: "patch", from: 0, to: 1 });
    expect(engine.readSince({ epoch: seed.epoch, revision: 1 }).update).toBeNull();
    engine.assign({ n: 2 });
    engine.readSince();
    expect(engine.readSince(cursor).update).toEqual({
      type: "snapshot",
      revision: 2,
      state: { n: 2 },
    });
    const restarted = new LiveState({ n: 2 }).readSince(cursor);
    expect(restarted.epoch).not.toBe(seed.epoch);
    expect(restarted.update).toMatchObject({ type: "snapshot", state: { n: 2 } });
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.observed).toBe(false);
  });

  it("bounds a slow sink to one outstanding call and coalesces its next update", async () => {
    const engine = new LiveState({ n: 0 }, { debounceMs: 0 });
    const store = createLiveStateStore<{ n: number }>();
    const updates: LiveUpdate<{ n: number }>[] = [];
    let acknowledge: () => void = () => {};
    const handle = engine.subscribe(
      (update) => {
        updates.push(update);
        store.apply(update, () => {
          throw new Error("unexpected revision gap");
        });
        return new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      },
      { patchVersion: 2 },
    );
    for (let n = 1; n <= 100; n++) {
      engine.assign({ n });
      vi.advanceTimersByTime(0);
    }
    expect(updates).toHaveLength(1);
    acknowledge();
    await Promise.resolve();
    expect(updates).toHaveLength(2);
    expect(store.getState()).toEqual({ n: 100 });
    acknowledge();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    handle.unsubscribe();
  });

  it("drops a sink that never acknowledges and releases its timer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new LiveState({ n: 0 });
    const handle = engine.subscribe(() => new Promise(() => {}));
    vi.advanceTimersByTime(10_000);
    expect(handle.ping()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("acknowledgement timed out"),
      expect.anything(),
    );
    expect(vi.getTimerCount()).toBe(0);
    warn.mockRestore();
  });

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
    expect(updates).toEqual([{ type: "snapshot", revision: 1, state: { n: 2 } }]);
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

  it("reports whether any subscriber is currently observing the engine", () => {
    const engine = new LiveState({ n: 1 });
    expect(engine.observed).toBe(false);

    const first = collect(engine).handle;
    const second = collect(engine).handle;
    expect(engine.observed).toBe(true);

    first.unsubscribe();
    expect(engine.observed).toBe(true);
    second.unsubscribe();
    expect(engine.observed).toBe(false);
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
  // codebase (see ./retain.ts); these cases were originally proven on
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
