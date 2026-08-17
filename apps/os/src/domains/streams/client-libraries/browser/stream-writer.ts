// Single-writer election via the Web Locks API. Exactly one compatible tab holds the named
// lock at a time and is the WRITER: it owns the stream callback connection and writes events into
// the shared OPFS database. Every other compatible tab is a READER (its own wa-sqlite
// connection reads the same file). When the writer tab closes or navigates away the lock
// auto-releases and a waiting tab's callback fires, so failover is seamless with no leases or
// heartbeats to manage. Holding the lock for the tab's whole lifetime also signals "this tab
// is active", which discourages the browser from suspending it.
//
// The compatibility version is part of the lock name on purpose. During deploys, old tabs can
// keep running old JS while a new tab opens a newer local SQLite schema and drops/recreates
// the shared OPFS table. If both versions contended for the same lock, the new tab could sit
// forever as a reader with an empty migrated DB while the old lock holder never replays
// history. A versioned lock lets the new runtime take over immediately; the stream Durable
// Object still holds only one browser callback because every same-profile tab uses the
// same connectionKey and `openConnection()` replaces the old connection for that key.

export type WriterRole = {
  /**
   * Resolves once this tab wins the lock — OR once `release()` is called before the lock was
   * granted, so the promise never dangles when an election is torn down while still queued.
   * Consumers must re-check that they still own the runtime after it resolves (a release that
   * settles this does so precisely because ownership has already moved on).
   */
  whenWriter: Promise<void>;
  /**
   * Keep a granted lock until this writer's already-started database work
   * settles, even if `release()` is requested meanwhile. Register work before
   * yielding back to the event loop.
   */
  holdUntil(work: Promise<unknown>): void;
  /** Resign writer role (releases the lock so another tab can take over). */
  release(): void;
};

export function acquireWriterRole(args: {
  lockName: string;
  /**
   * "exclusive" (the default) is the writer election. "shared" is a WATCH on
   * someone else's exclusive lock: granted only once the holder is gone, and
   * multiple watchers coexist without queueing behind each other — see
   * {@link findNewerStreamDatabaseWriterLock}, which deliberately ignores shared
   * holders so a watch never reads as a live writer.
   */
  mode?: "exclusive" | "shared";
}): WriterRole {
  let releaseLock = () => {};
  // The lock is held until this promise resolves; resolving it === resigning.
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const heldWork = new Set<Promise<unknown>>();
  let releaseRequested = false;
  const finishReleaseIfReady = () => {
    if (releaseRequested && heldWork.size === 0) releaseLock();
  };
  let signalWriter = () => {};
  const whenWriter = new Promise<void>((resolve) => {
    signalWriter = resolve;
  });
  // An AbortSignal lets `release()` actually relinquish the request even before the lock
  // is granted (a pending request would otherwise keep us queued forever). Aborting a
  // not-yet-granted request rejects `locks.request` with an AbortError; aborting after the
  // callback ran is a no-op. `release()` resolves `held` once registered work
  // settles, so the callback's `await held` then returns and frees the lock.
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
      console.error(`[stream-writer] writer lock request failed for ${args.lockName}`, error);
    });
  return {
    whenWriter,
    holdUntil: (work) => {
      if (releaseRequested) {
        throw new Error("cannot register writer work after the writer role was released");
      }
      const tracked = Promise.resolve(work);
      heldWork.add(tracked);
      void tracked.then(
        () => {
          heldWork.delete(tracked);
          finishReleaseIfReady();
        },
        () => {
          heldWork.delete(tracked);
          finishReleaseIfReady();
        },
      );
    },
    release: () => {
      // Abort a not-yet-granted request, free a held lock, and settle whenWriter so an election
      // awaiting it can't hang forever when it's released before the lock was ever granted.
      // Registered work keeps a granted lock until it settles, so a late
      // SQLite mutation cannot overlap the successor.
      releaseRequested = true;
      abortController.abort();
      signalWriter();
      finishReleaseIfReady();
    },
  };
}

/**
 * A deterministic key containing every browser processor's schema version.
 * The key is part of the database-writer lock name, so a tab running a new
 * schema does not wait behind a tab running old code. Sorting makes processor
 * configuration order irrelevant.
 */
export function processorSchemaVersionKey(
  processors: readonly { slug: string; schemaVersion: number }[],
): string {
  return processors
    .map((processor) => `${processor.slug}@${processor.schemaVersion}`)
    .sort()
    .join("|");
}

/**
 * The Web Lock name for the tab that writes one stream's local SQLite database.
 * It includes {@link processorSchemaVersionKey}, so a tab with changed tables
 * can acquire a different lock instead of waiting behind old code.
 *
 * Different app versions therefore hold different locks over the same OPFS
 * file, so the lock alone cannot choose between them.
 * {@link findNewerStreamDatabaseWriterLock} is the other half of the contract:
 * old code that sees a lock for newer shared processor schemas stops writing
 * instead of repeatedly replacing the newer tables with its old schema.
 */
export function streamDatabaseWriterLockName(args: {
  projectId: string;
  streamPath: string;
  processorSchemaVersionKey: string;
}): string {
  return streamDatabaseWriterLockPrefix(args) + args.processorSchemaVersionKey;
}

/** Shared prefix for every app version's database-writer lock for one stream. */
function streamDatabaseWriterLockPrefix(args: { projectId: string; streamPath: string }): string {
  return `stream-writer:${args.projectId}:${args.streamPath}:browser-stream-database:`;
}

/** Parse a {@link processorSchemaVersionKey} into versions keyed by processor slug. */
export function parseProcessorSchemaVersionKey(key: string): Map<string, number> {
  const versions = new Map<string, number>();
  for (const entry of key.split("|")) {
    const at = entry.lastIndexOf("@");
    if (at <= 0) continue;
    const version = Number(entry.slice(at + 1));
    if (!Number.isFinite(version)) continue;
    versions.set(entry.slice(0, at), version);
  }
  return versions;
}

/**
 * Whether `otherKey` proves that another tab has newer schemas: every processor
 * present in both keys is at least our version, and at least one is newer.
 * Processors present in only one key are ignored because adding or removing a
 * processor establishes no version order. Equal or mixed-newer-and-older keys
 * return false.
 */
export function hasNewerSharedProcessorSchema(otherKey: string, ourKey: string): boolean {
  if (otherKey === ourKey) return false;
  const otherVersions = parseProcessorSchemaVersionKey(otherKey);
  let strictlyNewer = false;
  for (const [processorSlug, ourVersion] of parseProcessorSchemaVersionKey(ourKey)) {
    const otherVersion = otherVersions.get(processorSlug);
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
 * Return a held exclusive database-writer lock whose shared processor schemas
 * are newer than ours, or undefined when none is visible. A failed Locks API
 * query also returns undefined; without evidence of a newer live writer this
 * tab proceeds with its own schema.
 *
 * Only held exclusive locks count. A writer always holds its lock exclusively,
 * while a resigned tab's death WATCH rides the same name in shared mode — if
 * shared holders or pending requests counted, two resigned stale tabs would
 * each read the other's watch as a live newer writer and neither would ever
 * take over.
 */
export async function findNewerStreamDatabaseWriterLock(args: {
  projectId: string;
  streamPath: string;
  processorSchemaVersionKey: string;
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
  const prefix = streamDatabaseWriterLockPrefix(args);
  const ourName = streamDatabaseWriterLockName(args);
  for (const lock of state.held ?? []) {
    const name = lock?.name;
    if (name == null || name === ourName || !name.startsWith(prefix)) continue;
    if (lock.mode === "shared") continue;
    if (hasNewerSharedProcessorSchema(name.slice(prefix.length), args.processorSchemaVersionKey)) {
      return name;
    }
  }
  return undefined;
}
