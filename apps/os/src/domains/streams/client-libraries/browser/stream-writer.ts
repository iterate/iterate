// Single-writer election via the Web Locks API. Exactly one compatible tab holds the named
// lock at a time and is the WRITER: it owns the stream callback connection and writes events into
// the shared OPFS database. Every other compatible tab is a READER (its own wa-sqlite
// connection reads the same file). When the writer tab closes or navigates away the lock
// auto-releases and a waiting tab's callback fires, so failover is seamless with no leases or
// heartbeats to manage. Holding the lock for the tab's whole lifetime also signals "this tab
// is active", which discourages the browser from suspending it.
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
   * "exclusive" elects a writer; "shared" can observe an existing writer's release.
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
  let failWriter: (error: unknown) => void = () => {};
  const whenWriter = new Promise<void>((resolve, reject) => {
    signalWriter = resolve;
    failWriter = reject;
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
      failWriter(error);
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
