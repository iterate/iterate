// session-teardown.ts — WHAT A SESSION MUST UNDO AT ITS END, as a leaf (no imports): the one-entry-per-key
// register every IterateContext of a session shares, testable in the node lane.

/** WHAT THIS SESSION MUST UNDO AT ITS END — ONE entry per key: a lend relay (the session's copy of
 *  a client stub plus its pager socket, held so neither is GC'd) and anything else scoped to the
 *  session (an anonymous subscription's removal). THE CALLER OWNS THE KEY: one session spans every
 *  IterateContext it hands out, and an rpc stub key is only unique PER CONTEXT, so IterateContext
 *  keys by the composite `"<iterateContextName> <rpcStubKey>"` (see #sessionTeardownKey) — the bare key would
 *  let two contexts lending at the same path recall each other's stub. Re-adding the SAME key is a
 *  TRANSPORT REPLACEMENT (a re-lend at the same context + path — a reconnect): by the time the new
 *  relay's pager is open, the DO has already dropped the old transport as "replaced", so disposing
 *  the incumbent here is a harmless double-close that just keeps this map from accumulating dead
 *  relays. */
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  /** Register `undo` under `key`, REPLACING what sat there (disposed now). Returns the LEASE — the
   *  one thing a handle should hold: its dispose runs `undo` only while `undo` is still the current
   *  entry, so a stale handle (re-provide at the same match, then dispose the OLD handle) can never tear
   *  down its replacement (the v4 review's kernel finding 2.6). */
  add(key: string, undo: { dispose(): void }): { dispose(): void } {
    this.#undoByKey.get(key)?.dispose();
    this.#undoByKey.set(key, undo);
    return {
      dispose: () => {
        if (this.#undoByKey.get(key) !== undo) return; // replaced — the replacement owns the key now
        this.#undoByKey.delete(key);
        undo.dispose();
      },
    };
  }
  /** Dispose whatever sits under `key` now — the SESSION's own act (a `provide(match, null)`, a
   *  `subscribe` re-spelled as an expression), never a handle's. */
  dispose(key: string): void {
    const undo = this.#undoByKey.get(key);
    if (!undo) return;
    this.#undoByKey.delete(key);
    undo.dispose();
  }
  disposeAll(): void {
    for (const undo of this.#undoByKey.values()) undo.dispose();
    this.#undoByKey.clear();
  }
}
