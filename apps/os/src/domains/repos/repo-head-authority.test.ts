import { describe, expect, it } from "vitest";
import {
  decideHeadResolution,
  frontierTips,
  isObservedPushRecord,
  observeExternalPushTransition,
  recordOwnPushTransition,
  shouldRetryHeadResolution,
  type RepoHeadAuthority,
} from "./repo-head-authority.ts";

const EMPTY: RepoHeadAuthority = { observedPushes: [], pushedFloor: undefined };

function observe(authority: RepoHeadAuthority, before: string | null, after: string | null) {
  return observeExternalPushTransition(authority, {
    afterCommitOid: after,
    beforeCommitOid: before,
  });
}

describe("repo head authority", () => {
  it("caches any resolution when no authority facts are outstanding", () => {
    expect(decideHeadResolution(EMPTY, "a")).toEqual({ cache: true });
    expect(shouldRetryHeadResolution(EMPTY, "a")).toBe(false);
  });

  it("never durably re-adopts a stale tip after observing an external push (warm cache)", () => {
    // Head A cached, observation A->B arrives, the eventually consistent
    // remote still serves A: A may be served but never re-cached.
    const own = recordOwnPushTransition(EMPTY, { beforeCommitOid: null, commitOid: "a" });
    const observed = observe(own, "a", "b");
    expect(observed.invalidate).toBe(true);
    expect(decideHeadResolution(observed.authority, "a")).toEqual({
      cache: false,
      reason: "unsettled-external-push",
    });
    expect(shouldRetryHeadResolution(observed.authority, "a")).toBe(true);
    // Only the frontier tip settles.
    expect(decideHeadResolution(observed.authority, "b")).toEqual({ cache: true });
  });

  it("protects a COLD observation — nothing was cached, yet a pre-push tip is still refused", () => {
    const observed = observe(EMPTY, "a", "b");
    expect(observed.invalidate).toBe(true);
    expect(decideHeadResolution(observed.authority, "a").cache).toBe(false);
  });

  it("refuses tips OLDER than any it ever cached (multi-hop eventual-consistency regression)", () => {
    // Push chain a -> b -> c delivered in order; a replica regressing all the
    // way to a (or b) must not be re-adopted.
    const first = observe(EMPTY, "a", "b").authority;
    const second = observe(first, "b", "c");
    expect(frontierTips(second.authority.observedPushes)).toEqual(["c"]);
    expect(decideHeadResolution(second.authority, "a").cache).toBe(false);
    expect(decideHeadResolution(second.authority, "b").cache).toBe(false);
    expect(decideHeadResolution(second.authority, "c").cache).toBe(true);
  });

  it("a LATE FIRST DELIVERY of an older push prunes itself — the Bugbot reorder scenario", () => {
    // Pushes a->b then b->c happen remotely; the queue delivers b->c FIRST.
    const newerFirst = observe(EMPTY, "b", "c");
    expect(decideHeadResolution(newerFirst.authority, "c").cache).toBe(true);
    // The older push a->b arrives late, for the first time: its after ("b")
    // is the newer push's before, so it sits below the frontier — it must
    // neither become the settle target nor evict the warm cache.
    const lateOlder = observe(newerFirst.authority, "a", "b");
    expect(lateOlder.invalidate).toBe(false);
    expect(frontierTips(lateOlder.authority.observedPushes)).toEqual(["c"]);
    expect(decideHeadResolution(lateOlder.authority, "b").cache).toBe(false);
    expect(decideHeadResolution(lateOlder.authority, "c").cache).toBe(true);
  });

  it("a three-push chain converges under any delivery permutation", () => {
    // a->b, b->c, c->d delivered as (c->d, a->b, b->c).
    let authority = observe(EMPTY, "c", "d").authority;
    authority = observe(authority, "a", "b").authority;
    authority = observe(authority, "b", "c").authority;
    expect(frontierTips(authority.observedPushes)).toEqual(["d"]);
    for (const stale of ["a", "b", "c"]) {
      expect(decideHeadResolution(authority, stale).cache).toBe(false);
    }
    expect(decideHeadResolution(authority, "d").cache).toBe(true);
  });

  it("treats an exact redelivery as a no-op that keeps the warm cache", () => {
    const first = observe(EMPTY, "a", "b");
    const redelivered = observe(first.authority, "a", "b");
    expect(redelivered.invalidate).toBe(false);
    expect(redelivered.authority).toEqual(first.authority);
  });

  it("an echo of the object's own push is a duplicate pair — the floor survives", () => {
    const own = recordOwnPushTransition(EMPTY, { beforeCommitOid: "p", commitOid: "a" });
    const echo = observe(own, "p", "a");
    expect(echo.invalidate).toBe(false);
    expect(echo.authority.pushedFloor).toBe("a");
    expect(decideHeadResolution(echo.authority, "stale")).toEqual({
      cache: false,
      reason: "behind-own-push",
    });
  });

  it("a late external push from BEFORE an own write prunes against the own pair", () => {
    // The DO pushed p->a (floor a). An external push o->p from before that
    // write arrives late: p is the own pair's before, so the stale push
    // cannot displace the floor or the frontier.
    const own = recordOwnPushTransition(EMPTY, { beforeCommitOid: "p", commitOid: "a" });
    const late = observe(own, "o", "p");
    expect(late.invalidate).toBe(false);
    expect(late.authority.pushedFloor).toBe("a");
    expect(decideHeadResolution(late.authority, "p").cache).toBe(false);
    expect(decideHeadResolution(late.authority, "a").cache).toBe(true);
  });

  it("a genuine external push chaining past the floor supersedes it", () => {
    const own = recordOwnPushTransition(EMPTY, { beforeCommitOid: null, commitOid: "a" });
    const observed = observe(own, "a", "b");
    expect(observed.invalidate).toBe(true);
    expect(observed.authority.pushedFloor).toBeUndefined();
    expect(decideHeadResolution(observed.authority, "a").cache).toBe(false);
    expect(decideHeadResolution(observed.authority, "b").cache).toBe(true);
  });

  it("an own push settles an outstanding observation", () => {
    const observed = observe(EMPTY, "a", "b").authority;
    const own = recordOwnPushTransition(observed, { beforeCommitOid: "b", commitOid: "c" });
    expect(own.pushedFloor).toBe("c");
    expect(decideHeadResolution(own, "c").cache).toBe(true);
    expect(decideHeadResolution(own, "b").cache).toBe(false);
  });

  it("a ref DELETION refuses every resolution and never retries the clone", () => {
    const observed = observe(EMPTY, "a", null);
    expect(observed.invalidate).toBe(true);
    expect(decideHeadResolution(observed.authority, "a").cache).toBe(false);
    expect(decideHeadResolution(observed.authority, "anything").cache).toBe(false);
    // There is no oid to converge toward — re-cloning cannot settle it.
    expect(shouldRetryHeadResolution(observed.authority, "a")).toBe(false);
  });

  it("a ref RECREATION supersedes an outstanding deletion (zero-oid chaining)", () => {
    // Deletion a->null then creation null->e: creation's null before prunes
    // the deletion's null after, in either delivery order.
    let authority = observe(EMPTY, "a", null).authority;
    authority = observe(authority, null, "e").authority;
    expect(frontierTips(authority.observedPushes)).toEqual(["e"]);
    expect(decideHeadResolution(authority, "e").cache).toBe(true);

    let reordered = observe(EMPTY, null, "e").authority;
    reordered = observe(reordered, "a", null).authority;
    expect(frontierTips(reordered.observedPushes)).toEqual(["e"]);
  });

  it("retries the clone while behind the own-push floor", () => {
    const own = recordOwnPushTransition(EMPTY, { beforeCommitOid: "a", commitOid: "b" });
    expect(shouldRetryHeadResolution(own, "a")).toBe(true);
    expect(shouldRetryHeadResolution(own, "b")).toBe(false);
  });

  it("validates stored window elements (legacy bare strings are rejected)", () => {
    expect(isObservedPushRecord({ afterCommitOid: "a", beforeCommitOid: null })).toBe(true);
    expect(isObservedPushRecord({ afterCommitOid: null, beforeCommitOid: "a" })).toBe(true);
    expect(isObservedPushRecord("bare-oid")).toBe(false);
    expect(isObservedPushRecord({ afterCommitOid: 3, beforeCommitOid: null })).toBe(false);
    expect(isObservedPushRecord({ afterCommitOid: "a" })).toBe(false);
    expect(isObservedPushRecord(null)).toBe(false);
  });
});
