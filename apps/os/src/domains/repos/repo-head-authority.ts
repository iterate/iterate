/**
 * The pure decision core of the repo DO's branch-head cache authority.
 *
 * Two facts govern what a clone's resolved head may become:
 *
 * - `pushedFloor` — the last oid THIS object pushed. Its own writes are
 *   ordered, so anything else resolved from the eventually consistent remote
 *   is behind by construction (read-your-write).
 * - `expectedTip` — an observed EXTERNAL push (queue-delivered, unordered,
 *   possibly duplicated). The event's `after` oid is visibility evidence:
 *   until a fresh resolution actually shows that oid, the authority is
 *   unsettled and no resolution may be durably cached — an eventually
 *   consistent replica can keep serving any pre-push tip (including one we
 *   never had cached), and durably re-adopting it would pin staleness until
 *   the next write. `afterCommitOid: null` records a ref deletion: nothing
 *   the remote still serves for that branch may be cached.
 *
 * Resolutions that may not be cached are still SERVED once — availability is
 * preserved; only durable authority waits for the evidence. Convergence: after
 * the last transition, the only cacheable resolution is that transition's oid
 * (own push caches directly; external settles on match), so permutations and
 * duplicates of queue deliveries cannot park the cache on a stale tip.
 */
export interface RepoHeadAuthority {
  expectedTip: { afterCommitOid: string | null } | undefined;
  pushedFloor: string | undefined;
}

type RepoHeadResolutionDecision =
  | { cache: true; settlesExpectedTip: boolean }
  | { cache: false; reason: "behind-own-push" | "unsettled-external-push" };

/** May this resolved head become the durable head record / tree sentinel? */
export function decideHeadResolution(
  authority: RepoHeadAuthority,
  resolvedOid: string,
): RepoHeadResolutionDecision {
  if (authority.pushedFloor !== undefined && authority.pushedFloor !== resolvedOid) {
    return { cache: false, reason: "behind-own-push" };
  }
  if (authority.expectedTip !== undefined && authority.expectedTip.afterCommitOid !== resolvedOid) {
    return { cache: false, reason: "unsettled-external-push" };
  }
  return { cache: true, settlesExpectedTip: authority.expectedTip !== undefined };
}

/**
 * Should the clone lane retry for a fresher replica? Only when there is a
 * concrete oid to converge toward — a deletion observation has none, and
 * re-cloning cannot settle it.
 */
export function shouldRetryHeadResolution(
  authority: RepoHeadAuthority,
  resolvedOid: string,
): boolean {
  const deletionObserved =
    authority.expectedTip !== undefined && authority.expectedTip.afterCommitOid === null;
  return decideHeadResolution(authority, resolvedOid).cache === false && !deletionObserved;
}

type ObservedPushTransition =
  | { authority: RepoHeadAuthority; invalidate: true }
  | { invalidate: false; reason: "own-push-echo" };

/**
 * Fold an external push observation. An echo of this object's own push (the
 * observed oid IS the read-your-write floor) proves the remote has caught up
 * with us — invalidating on it would erase the floor's protection for
 * nothing. Everything else supersedes both prior facts: the floor's oid is
 * outdated, and the new `after` becomes the settle evidence.
 */
export function observeExternalPushTransition(
  authority: RepoHeadAuthority,
  afterCommitOid: string | null,
): ObservedPushTransition {
  if (afterCommitOid !== null && authority.pushedFloor === afterCommitOid) {
    return { invalidate: false, reason: "own-push-echo" };
  }
  return {
    authority: { expectedTip: { afterCommitOid }, pushedFloor: undefined },
    invalidate: true,
  };
}

/** Fold this object's own push: ordered, authoritative, settles everything. */
export function recordOwnPushTransition(commitOid: string): RepoHeadAuthority {
  return { expectedTip: undefined, pushedFloor: commitOid };
}
