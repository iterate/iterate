// The shared coordination object between a browser stream processor and the
// transactional progress store (processor-state-storage.ts): the processor's
// synchronous `processEvent` APPENDS projection writes here per event, and the
// store's `commit` DRAINS them into the SAME SQLite transaction that persists
// the two-cursor progress record. That one-transaction commit is the whole
// point of the browser runner cutover — the legacy path committed projection
// rows and the checkpoint separately, so a crash between the two left the
// mirror and the resume cursor disagreeing.
//
// Buffer model (all invariants enforced here, so both processors stay dumb):
//
//   - Writes are keyed by the SOURCE EVENT OFFSET and arrive in ascending
//     offset order (the runner drives one event at a time from the committed
//     cursor). Appending offset K evicts every buffered write at offset >= K:
//     a redelivered frame re-derives its writes from the committed state, so
//     whatever a failed earlier attempt left buffered for those offsets is
//     superseded, never replayed alongside.
//   - `drainThrough(ack)` removes and materializes exactly the writes covered
//     by the acknowledgement being committed. If the transaction then fails,
//     the drained writes are GONE — deliberately: the runner never advances
//     its cursor past a failed commit, so the redelivered frame regenerates
//     them (see the eviction rule above). Nothing is ever half-applied; the
//     transaction's rollback is the atomicity story.
//   - `coalesceKey` collapses repeated writes to the same projection row into
//     ONE statement per commit (the browser feed's open raw-group row grows
//     with every event; serializing its cumulative data per event would be
//     O(n^2) bytes on the exact deep-catch-up path the mirror's flow control
//     protects). A pending same-key write is replaced in place; statements
//     are built lazily at drain time so the replaced ones cost nothing.
//   - `coveredOffset` is the highest offset known applied-or-buffered,
//     hydrated from the acknowledged cursor at load. The raw-events processor
//     reads it for its lost-delivery gap check — under the transactional
//     commit the mirror head and the cursor move together, so the cursor IS
//     the mirror head and no per-event SQL read is needed.

import type { SqlValue } from "./stream-browser-db.ts";

type BufferedProjectionStatement = { sql: string; params?: SqlValue[] };

type ProjectionWrite = {
  /** Materialized at drain time (once per commit, after any coalescing). */
  build: () => BufferedProjectionStatement;
  /** Writes sharing a key collapse to one pending statement (last wins). */
  coalesceKey?: string;
};

type BufferEntry = {
  offset: number;
  coalesceKey: string | undefined;
  build: () => BufferedProjectionStatement;
};

export class BrowserProjectionWriteBuffer {
  /** Ascending by offset — appends come from the runner's ordered drive. */
  #entries: BufferEntry[] = [];
  #byCoalesceKey = new Map<string, BufferEntry>();
  #coveredOffset: number | undefined;

  /** Highest offset applied-or-buffered; `undefined` before the first hydrate. */
  get coveredOffset(): number | undefined {
    return this.#coveredOffset;
  }

  get pendingCount(): number {
    return this.#entries.length;
  }

  /**
   * Re-baseline from the durable acknowledged cursor (the progress store calls
   * this on every read). Clears any pending writes: a fresh load means no
   * in-flight frame owns them, and a discarded mirror's rewound cursor must
   * not inherit writes derived against the pre-discard state.
   */
  hydrate(acknowledgedThroughOffset: number): void {
    this.#entries = [];
    this.#byCoalesceKey.clear();
    this.#coveredOffset = acknowledgedThroughOffset;
  }

  /** Buffer one event's projection writes (evicting superseded ones — see module doc). */
  append(offset: number, writes: readonly ProjectionWrite[]): void {
    const firstSuperseded = this.#entries.findIndex((entry) => entry.offset >= offset);
    if (firstSuperseded !== -1) {
      for (const entry of this.#entries.splice(firstSuperseded)) {
        if (entry.coalesceKey !== undefined) this.#byCoalesceKey.delete(entry.coalesceKey);
      }
    }
    for (const write of writes) {
      if (write.coalesceKey !== undefined) {
        const pending = this.#byCoalesceKey.get(write.coalesceKey);
        if (pending !== undefined) {
          // Replace in place: the entry keeps its original offset slot, so a
          // later `drainThrough` / eviction still treats the row's statement
          // as belonging to the commit that first touched it.
          pending.build = write.build;
          continue;
        }
      }
      const entry: BufferEntry = { offset, coalesceKey: write.coalesceKey, build: write.build };
      this.#entries.push(entry);
      if (entry.coalesceKey !== undefined) this.#byCoalesceKey.set(entry.coalesceKey, entry);
    }
    this.#coveredOffset =
      this.#coveredOffset === undefined ? offset : Math.max(this.#coveredOffset, offset);
  }

  /**
   * Remove and materialize every write at or below `offset` (the
   * acknowledgement the enclosing commit is about to persist), in append
   * order. Writes past `offset` stay buffered — with the runner's per-frame
   * commit cadence there never are any; this keeps a future mid-frame cadence
   * from silently committing writes ahead of their acknowledgement.
   */
  drainThrough(offset: number): BufferedProjectionStatement[] {
    let count = 0;
    while (count < this.#entries.length && this.#entries[count]!.offset <= offset) count += 1;
    const drained = this.#entries.splice(0, count);
    for (const entry of drained) {
      if (entry.coalesceKey !== undefined) this.#byCoalesceKey.delete(entry.coalesceKey);
    }
    return drained.map((entry) => entry.build());
  }
}
