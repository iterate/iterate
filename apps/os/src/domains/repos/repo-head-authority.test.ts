import { describe, expect, it } from "vitest";
import {
  decideHeadResolution,
  observeExternalPushTransition,
  recordOwnPushTransition,
  shouldRetryHeadResolution,
  type RepoHeadAuthority,
} from "./repo-head-authority.ts";

const SETTLED: RepoHeadAuthority = { expectedTip: undefined, pushedFloor: undefined };

describe("repo head authority", () => {
  it("caches any resolution when no authority facts are outstanding", () => {
    expect(decideHeadResolution(SETTLED, "a")).toEqual({ cache: true, settlesExpectedTip: false });
    expect(shouldRetryHeadResolution(SETTLED, "a")).toBe(false);
  });

  it("never durably re-adopts a stale tip after observing an external push (warm cache)", () => {
    // Head A cached, observation B arrives, the eventually consistent remote
    // still serves A: A may be served but must not become authority again.
    const observed = observeExternalPushTransition(recordOwnPushTransition("a"), "b");
    if (!observed.invalidate) throw new Error("expected an invalidating transition");
    expect(decideHeadResolution(observed.authority, "a")).toEqual({
      cache: false,
      reason: "unsettled-external-push",
    });
    expect(shouldRetryHeadResolution(observed.authority, "a")).toBe(true);
    // Only the observed oid settles the authority.
    expect(decideHeadResolution(observed.authority, "b")).toEqual({
      cache: true,
      settlesExpectedTip: true,
    });
  });

  it("protects a COLD observation — nothing was cached, yet a pre-push tip is still refused", () => {
    const observed = observeExternalPushTransition(SETTLED, "b");
    if (!observed.invalidate) throw new Error("expected an invalidating transition");
    expect(decideHeadResolution(observed.authority, "a").cache).toBe(false);
  });

  it("refuses tips OLDER than any it ever cached (multi-hop eventual-consistency regression)", () => {
    // Push chain a -> b -> c. b settles, then c is observed; a replica
    // regressing all the way to a must not be re-adopted (a tip avoid-list
    // keyed on the last-invalidated record would miss this).
    const first = observeExternalPushTransition(SETTLED, "b");
    if (!first.invalidate) throw new Error("expected an invalidating transition");
    expect(decideHeadResolution(first.authority, "b").cache).toBe(true);
    const second = observeExternalPushTransition(SETTLED, "c");
    if (!second.invalidate) throw new Error("expected an invalidating transition");
    expect(decideHeadResolution(second.authority, "a").cache).toBe(false);
    expect(decideHeadResolution(second.authority, "b").cache).toBe(false);
    expect(decideHeadResolution(second.authority, "c").cache).toBe(true);
  });

  it("treats an echo of the object's own push as a no-op — the floor survives", () => {
    const own = recordOwnPushTransition("a");
    expect(observeExternalPushTransition(own, "a")).toEqual({
      invalidate: false,
      reason: "own-push-echo",
    });
    // The floor still refuses older replicas afterwards.
    expect(decideHeadResolution(own, "stale")).toEqual({ cache: false, reason: "behind-own-push" });
  });

  it("a genuine external push supersedes the read-your-write floor", () => {
    const observed = observeExternalPushTransition(recordOwnPushTransition("a"), "b");
    if (!observed.invalidate) throw new Error("expected an invalidating transition");
    expect(observed.authority.pushedFloor).toBeUndefined();
    expect(decideHeadResolution(observed.authority, "b").cache).toBe(true);
  });

  it("an own push settles an outstanding observation", () => {
    const observed = observeExternalPushTransition(SETTLED, "b");
    if (!observed.invalidate) throw new Error("expected an invalidating transition");
    const own = recordOwnPushTransition("c");
    expect(own.expectedTip).toBeUndefined();
    expect(decideHeadResolution(own, "c").cache).toBe(true);
  });

  it("a ref DELETION observation refuses every resolution and never retries the clone", () => {
    const observed = observeExternalPushTransition(recordOwnPushTransition("a"), null);
    if (!observed.invalidate) throw new Error("expected an invalidating transition");
    expect(decideHeadResolution(observed.authority, "a").cache).toBe(false);
    expect(decideHeadResolution(observed.authority, "anything").cache).toBe(false);
    // There is no oid to converge toward — re-cloning cannot settle it.
    expect(shouldRetryHeadResolution(observed.authority, "a")).toBe(false);
  });

  it("retries the clone while behind the own-push floor", () => {
    const own = recordOwnPushTransition("b");
    expect(shouldRetryHeadResolution(own, "a")).toBe(true);
    expect(shouldRetryHeadResolution(own, "b")).toBe(false);
  });
});
