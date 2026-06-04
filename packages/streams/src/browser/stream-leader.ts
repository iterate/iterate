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
  void navigator.locks.request(args.lockName, { mode: "exclusive" }, async () => {
    signalWriter();
    await held;
  });
  return { whenWriter, release: () => release() };
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
