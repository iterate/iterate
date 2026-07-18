// Single-writer election via the Web Locks API. Exactly one compatible tab holds the named
// lock at a time and is the WRITER: it owns the stream subscription and writes events into
// the shared OPFS database. Every other compatible tab is a READER (its own wa-sqlite
// connection reads the same file). When the writer tab closes or navigates away the lock
// auto-releases and a waiting tab's callback fires, so failover is seamless with no leases or
// heartbeats to manage. Holding the lock for the tab's whole lifetime also signals "this tab
// is active", which discourages the browser from suspending it.
//
// The compatibility version is part of the lock name on purpose. During deploys, old tabs can
// keep running old JS while a new tab opens a newer local SQLite schema and drops/recreates
// the shared OPFS table. If both versions contended for the same lock, the new tab could sit
// forever as a follower with an empty migrated DB while the old lock holder never replays
// history. A versioned lock lets the new runtime take over immediately; the stream Durable
// Object still receives only one browser subscriber because every same-profile tab uses the
// same subscriptionKey and `subscribe()` replaces the old connection for that key.

export type WriterRole = {
  /**
   * Resolves once this tab wins the lock — OR once `release()` is called before the lock was
   * granted, so the promise never dangles when an election is torn down while still queued.
   * Consumers must re-check that they still own the runtime after it resolves (a release that
   * settles this does so precisely because ownership has already moved on).
   */
  whenWriter: Promise<void>;
  /** Resign writer role (releases the lock so another tab can take over). */
  release(): void;
};

export function acquireWriterRole(args: {
  lockName: string;
  /**
   * "exclusive" (the default) is the writer election. "shared" is a WATCH on
   * someone else's exclusive lock: granted only once the holder is gone, and
   * multiple watchers coexist without queueing behind each other — see
   * {@link findSupersedingMirrorWriterLock}, which deliberately ignores shared
   * holders so a watch never reads as a live writer.
   */
  mode?: "exclusive" | "shared";
}): WriterRole {
  let release = () => {};
  // The lock is held until this promise resolves; resolving it === resigning.
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalWriter = () => {};
  const whenWriter = new Promise<void>((resolve) => {
    signalWriter = resolve;
  });
  // An AbortSignal lets `release()` actually relinquish the request even before the lock
  // is granted (a pending request would otherwise keep us queued forever). Aborting a
  // not-yet-granted request rejects `locks.request` with an AbortError; aborting after the
  // callback ran is a no-op. Either way release() also resolves `held`, so the callback's
  // `await held` returns and the held lock is freed.
  const abortController = new AbortController();
  navigator.locks
    .request(
      args.lockName,
      { mode: args.mode ?? "exclusive", signal: abortController.signal },
      async () => {
        signalWriter();
        await held;
      },
    )
    .catch((error: unknown) => {
      // AbortError is the expected outcome of release()-before-grant; anything else is a
      // genuine failure to acquire the lock and must not be swallowed silently.
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error(`[stream-leader] writer lock request failed for ${args.lockName}`, error);
    });
  return {
    whenWriter,
    release: () => {
      // Abort a not-yet-granted request, free a held lock, and settle whenWriter so an election
      // awaiting it can't hang forever when it's released before the lock is ever granted.
      abortController.abort();
      release();
      signalWriter();
    },
  };
}

/**
 * A deterministic compatibility vector over a mirror's member set, baked into
 * the writer-lock name so a deploy that bumps ANY member's schema changes the
 * lock and lets a fresh tab re-elect (instead of sitting forever behind an old
 * tab's lock). Derived from the members — never hand-maintained, so there is no
 * number to forget to bump. Sorted so member order can't change the identity.
 */
export function mirrorLockVersionVector(
  members: readonly { slug: string; schemaVersion: number }[],
): string {
  return members
    .map((member) => `${member.slug}@${member.schemaVersion}`)
    .sort()
    .join("|");
}

/**
 * The Web Lock name electing the single writer for one stream MIRROR (the
 * runtime that downloads once and fans out to the canonical processor set).
 * Versioned by {@link mirrorLockVersionVector}, so a deploy that migrates any
 * member's projection lets a fresh tab re-elect immediately instead of waiting
 * behind an old tab's lock — the same failover a per-processor lock gave, now
 * per mirror.
 *
 * The versioned name means cross-deploy tabs hold DIFFERENT locks over the
 * SAME shared OPFS file, so the lock alone cannot arbitrate between them.
 * {@link findSupersedingMirrorWriterLock} is the other half of the contract:
 * a tab that finds a strictly-newer vector's lock held must resign as writer
 * instead of rebuilding the mirror down to its own older schema (two writers
 * rebuilding in opposite directions fence each other's cursors forever — the
 * deploy-boundary livelock).
 */
export function streamMirrorWriterLockName(args: {
  projectId: string;
  streamPath: string;
  versionVector: string;
}): string {
  return streamMirrorWriterLockPrefix(args) + args.versionVector;
}

/** Shared name prefix for every version vector's writer lock on one stream mirror. */
function streamMirrorWriterLockPrefix(args: { projectId: string; streamPath: string }): string {
  return `stream-writer:${args.projectId}:${args.streamPath}:browser-stream-mirror:`;
}

/** Parse a {@link mirrorLockVersionVector} string back into per-member schema versions. */
export function parseLockVersionVector(vector: string): Map<string, number> {
  const versions = new Map<string, number>();
  for (const entry of vector.split("|")) {
    const at = entry.lastIndexOf("@");
    if (at <= 0) continue;
    const version = Number(entry.slice(at + 1));
    if (!Number.isFinite(version)) continue;
    versions.set(entry.slice(0, at), version);
  }
  return versions;
}

/**
 * Whether `other` is a strictly NEWER compatibility vector than `ours`: every
 * member both vectors share is at least our version, and at least one shared
 * member is ahead. Members only one side has are ignored — deploys add and
 * remove members, and an unshared member carries no before/after ordering.
 * Incomparable or equal vectors answer false: when in doubt, contend as usual
 * rather than resign (a wrong "not newer" costs one bounded fence/re-elect
 * cycle; a wrong "newer" would park a healthy writer forever).
 */
export function vectorSupersedes(other: string, ours: string): boolean {
  if (other === ours) return false;
  const otherVersions = parseLockVersionVector(other);
  let strictlyNewer = false;
  for (const [member, ourVersion] of parseLockVersionVector(ours)) {
    const otherVersion = otherVersions.get(member);
    if (otherVersion === undefined) continue;
    if (otherVersion < ourVersion) return false;
    if (otherVersion > ourVersion) strictlyNewer = true;
  }
  return strictlyNewer;
}

/** The subset of `navigator.locks.query()` this module reads, injectable for tests. */
type LocksQuerySnapshot = {
  held?: readonly { name?: string | null; mode?: string | null }[] | null;
};

/**
 * The name of a HELD EXCLUSIVE writer lock for this stream mirror whose
 * version vector {@link vectorSupersedes} ours — proof a newer-deploy tab is
 * ALIVE and owns the shared mirror right now — or undefined when no such tab
 * exists. Undefined is also the answer when the Locks API is unavailable or
 * the query fails: without evidence of a live newer writer we keep today's
 * behavior (rebuild to our own schema), which is what heals a rollback or an
 * abandoned upgrade.
 *
 * Only held exclusive locks count. A writer always holds its lock exclusively,
 * while a resigned tab's death WATCH rides the same name in shared mode — if
 * shared holders or pending requests counted, two resigned stale tabs would
 * each read the other's watch as a live newer writer and neither would ever
 * take over.
 */
export async function findSupersedingMirrorWriterLock(args: {
  projectId: string;
  streamPath: string;
  versionVector: string;
  queryLocks?: () => Promise<LocksQuerySnapshot>;
}): Promise<string | undefined> {
  const queryLocks =
    args.queryLocks ??
    (typeof navigator !== "undefined" && typeof navigator.locks?.query === "function"
      ? () => navigator.locks.query()
      : undefined);
  if (queryLocks === undefined) return undefined;
  let state: LocksQuerySnapshot;
  try {
    state = await queryLocks();
  } catch {
    return undefined;
  }
  const prefix = streamMirrorWriterLockPrefix(args);
  const ourName = streamMirrorWriterLockName(args);
  for (const lock of state.held ?? []) {
    const name = lock?.name;
    if (name == null || name === ourName || !name.startsWith(prefix)) continue;
    if (lock.mode === "shared") continue;
    if (vectorSupersedes(name.slice(prefix.length), args.versionVector)) return name;
  }
  return undefined;
}
