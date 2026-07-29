/**
 * The pure decision core of the repo DO's branch-head cache authority.
 *
 * Two facts govern what a clone's resolved head may become:
 *
 * - `pushedFloor` — the last oid THIS object pushed. Its own writes are
 *   ordered, so anything else resolved from the eventually consistent remote
 *   is behind by construction (read-your-write).
 * - `observedPushes` — recently observed pushes as `(before, after)` pairs
 *   (queue-delivered, unordered, possibly duplicated; own pushes are recorded
 *   here too). The pairs chain: a push's `before` is some earlier push's
 *   `after`. The {@link frontierTips} of that chain — afters no observed push
 *   builds upon — are the only resolutions that may be durably cached. This
 *   is ordering-free causal dominance: a push delivered late, in ANY
 *   permutation, prunes itself the moment the push built on top of it is
 *   known, so a lagging replica's pre-push tip can never be re-adopted — not
 *   from a warm cache, a cold one, a multi-hop regression, or an out-of-order
 *   first delivery. A `null` after records a ref deletion (nothing cacheable
 *   until superseded); a `null` before records a ref creation, which is
 *   exactly what supersedes an outstanding deletion.
 *
 * Ordinary content reads may still serve a non-cacheable resolution once;
 * `RepoDurableObject.getHead`, the worker-source boundary, rejects it as
 * temporarily unavailable so a stale worker cannot acknowledge source-change
 * work. Convergence: once every push in a window has been delivered, the
 * frontier is precisely the true tip.
 */
export interface ObservedPush {
  afterCommitOid: string | null;
  beforeCommitOid: string | null;
}

export interface RepoHeadAuthority {
  observedPushes: ObservedPush[];
  pushedFloor: string | undefined;
}

/** How many recent push observations to remember for chain pruning and
 * redelivery dedup. Far above any realistic queue disorder window; bounded so
 * the record cannot grow with repo history. */
const OBSERVED_PUSH_MEMORY = 16;

/** The afters no observed push builds upon — the only cacheable resolutions. */
export function frontierTips(pushes: ObservedPush[]): (string | null)[] {
  const befores = new Set(pushes.map((push) => push.beforeCommitOid));
  const tips: (string | null)[] = [];
  for (const push of pushes) {
    if (befores.has(push.afterCommitOid)) continue;
    if (tips.includes(push.afterCommitOid)) continue;
    tips.push(push.afterCommitOid);
  }
  return tips;
}

/** May this resolved head become the durable head record / tree sentinel? */
export function decideHeadResolution(
  authority: RepoHeadAuthority,
  resolvedOid: string,
): { cache: true } | { cache: false; reason: "behind-own-push" | "unsettled-external-push" } {
  if (authority.pushedFloor !== undefined && authority.pushedFloor !== resolvedOid) {
    return { cache: false, reason: "behind-own-push" };
  }
  const tips = frontierTips(authority.observedPushes);
  if (tips.length > 0 && !tips.includes(resolvedOid)) {
    return { cache: false, reason: "unsettled-external-push" };
  }
  return { cache: true };
}

/**
 * Should the clone lane retry for a fresher replica? Only when there is a
 * concrete oid to converge toward — an outstanding deletion has none, and
 * re-cloning cannot settle it.
 */
export function shouldRetryHeadResolution(
  authority: RepoHeadAuthority,
  resolvedOid: string,
): boolean {
  const decision = decideHeadResolution(authority, resolvedOid);
  if (decision.cache) return false;
  if (decision.reason === "behind-own-push") return true;
  return frontierTips(authority.observedPushes).some((tip) => tip !== null);
}

type ObservedPushTransition = {
  authority: RepoHeadAuthority;
  /** Evict the cached head/tree? False when the observation changed nothing
   * cacheability-wise: an exact redelivery, or a push some already-observed
   * push provably supersedes (its after sits below the frontier). */
  invalidate: boolean;
};

/**
 * Fold an external push observation. The pair joins the observed window; the
 * read-your-write floor survives only while it is still a frontier tip —
 * a push chaining past it proves the floor's oid outdated.
 */
export function observeExternalPushTransition(
  authority: RepoHeadAuthority,
  push: ObservedPush,
): ObservedPushTransition {
  const duplicate = authority.observedPushes.some(
    (seen) =>
      seen.afterCommitOid === push.afterCommitOid && seen.beforeCommitOid === push.beforeCommitOid,
  );
  if (duplicate) return { authority, invalidate: false };
  const observedPushes = [...authority.observedPushes, push].slice(-OBSERVED_PUSH_MEMORY);
  const tips = frontierTips(observedPushes);
  const pushedFloor =
    authority.pushedFloor !== undefined && tips.includes(authority.pushedFloor)
      ? authority.pushedFloor
      : undefined;
  const frontierUnchanged =
    pushedFloor === authority.pushedFloor &&
    JSON.stringify(tips) === JSON.stringify(frontierTips(authority.observedPushes));
  return { authority: { observedPushes, pushedFloor }, invalidate: !frontierUnchanged };
}

/** Fold this object's own push: ordered, authoritative. The pair joins the
 * observed window so a late-delivered external push from BEFORE this write
 * prunes itself against it. */
export function recordOwnPushTransition(
  authority: RepoHeadAuthority,
  push: { beforeCommitOid: string | null; commitOid: string },
): RepoHeadAuthority {
  const pair = {
    afterCommitOid: push.commitOid,
    beforeCommitOid: push.beforeCommitOid,
  };
  const already = authority.observedPushes.some(
    (seen) =>
      seen.afterCommitOid === pair.afterCommitOid && seen.beforeCommitOid === pair.beforeCommitOid,
  );
  return {
    observedPushes: already
      ? authority.observedPushes
      : [...authority.observedPushes, pair].slice(-OBSERVED_PUSH_MEMORY),
    pushedFloor: push.commitOid,
  };
}

/** Element validation for the durably stored observed-push window (no casts:
 * `in` narrowing carries the property reads). */
export function isObservedPushRecord(value: unknown): value is ObservedPush {
  if (typeof value !== "object" || value === null) return false;
  if (!("afterCommitOid" in value) || !("beforeCommitOid" in value)) return false;
  const { afterCommitOid, beforeCommitOid } = value;
  return (
    (typeof afterCommitOid === "string" || afterCommitOid === null) &&
    (typeof beforeCommitOid === "string" || beforeCommitOid === null)
  );
}
