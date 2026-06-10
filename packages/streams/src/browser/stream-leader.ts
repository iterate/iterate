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
  /** Resolves true once this tab wins the lock; never resolves false (it just keeps waiting). */
  whenWriter: Promise<void>;
  /** Resign writer role (releases the lock so another tab can take over). */
  release(): void;
};

export function acquireWriterRole(args: { lockName: string }): WriterRole {
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
    .request(args.lockName, { mode: "exclusive", signal: abortController.signal }, async () => {
      signalWriter();
      await held;
    })
    .catch((error: unknown) => {
      // AbortError is the expected outcome of release()-before-grant; anything else is a
      // genuine failure to acquire the lock and must not be swallowed silently.
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error(`[stream-leader] writer lock request failed for ${args.lockName}`, error);
    });
  return {
    whenWriter,
    release: () => {
      abortController.abort();
      release();
    },
  };
}

/**
 * The Web Lock name electing the single writer for one (namespace, path, processor).
 * Versioned by the processor's schema so a deploy that migrates the shared OPFS DB lets a
 * fresh tab take over instead of waiting forever behind an old tab's lock.
 */
export function streamWriterLockName(args: {
  namespace: string;
  streamPath: string;
  slug: string;
  schemaVersion: number;
}): string {
  return `stream-writer:${args.namespace}:${args.streamPath}:${args.slug}:v${args.schemaVersion}`;
}
