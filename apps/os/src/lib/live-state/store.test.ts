import { describe, expect, it, vi } from "vitest";
import { createLiveStateStore } from "./store.ts";

describe("createLiveStateStore", () => {
  it("holds nothing until the first snapshot, then folds patches", () => {
    const store = createLiveStateStore<{ n: number }>();
    const resync = vi.fn();
    expect(store.getState()).toBeUndefined();
    store.apply({ type: "snapshot", revision: 0, state: { n: 1 } }, resync);
    expect(store.getState()).toEqual({ n: 1 });
    store.apply({ type: "patch", from: 0, to: 1, patch: { fields: { n: { set: 2 } } } }, resync);
    expect(store.getState()).toEqual({ n: 2 });
    expect(resync).not.toHaveBeenCalled();
  });

  it("a revision gap triggers resync and leaves the held value untouched", () => {
    const store = createLiveStateStore<{ n: number }>();
    const resync = vi.fn();
    store.apply({ type: "snapshot", revision: 0, state: { n: 1 } }, resync);
    // A missed message: from=1 but we hold revision 0. Never applied.
    store.apply({ type: "patch", from: 1, to: 2, patch: { fields: { n: { set: 9 } } } }, resync);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ n: 1 });
  });

  it("a straggler patch from a stale revision line resyncs instead of applying", () => {
    const store = createLiveStateStore<{ n: number }>();
    const resync = vi.fn();
    // New subscription's snapshot restarts the revision line at 0…
    store.apply({ type: "snapshot", revision: 0, state: { n: 5 } }, resync);
    store.apply({ type: "patch", from: 0, to: 1, patch: { fields: { n: { set: 6 } } } }, resync);
    // …so a dying subscription's in-flight from:3 patch reads as a gap.
    store.apply({ type: "patch", from: 3, to: 4, patch: { fields: { n: { set: 0 } } } }, resync);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ n: 6 });
  });

  it("a fresh snapshot recovers after a gap (resync path end-to-end)", () => {
    const store = createLiveStateStore<{ n: number }>();
    const resync = vi.fn();
    store.apply({ type: "snapshot", revision: 4, state: { n: 1 } }, resync);
    store.apply({ type: "patch", from: 9, to: 10, patch: { fields: { n: { set: 2 } } } }, resync);
    expect(resync).toHaveBeenCalledTimes(1);
    store.apply({ type: "snapshot", revision: 0, state: { n: 7 } }, resync);
    expect(store.getState()).toEqual({ n: 7 });
    store.apply({ type: "patch", from: 0, to: 1, patch: { fields: { n: { set: 8 } } } }, resync);
    expect(store.getState()).toEqual({ n: 8 });
  });

  it("notifies subscribers on every accepted update and on reset", () => {
    const store = createLiveStateStore<{ n: number }>();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.apply({ type: "snapshot", revision: 0, state: { n: 1 } }, () => {});
    expect(listener).toHaveBeenCalledTimes(1);
    store.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState()).toBeUndefined();
    unsubscribe();
    store.apply({ type: "snapshot", revision: 0, state: { n: 2 } }, () => {});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does NOT notify on a gapped patch (nothing changed for renderers)", () => {
    const store = createLiveStateStore<{ n: number }>();
    const listener = vi.fn();
    store.subscribe(listener);
    store.apply({ type: "snapshot", revision: 0, state: { n: 1 } }, () => {});
    store.apply({ type: "patch", from: 7, to: 8, patch: { fields: { n: { set: 9 } } } }, () => {});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
