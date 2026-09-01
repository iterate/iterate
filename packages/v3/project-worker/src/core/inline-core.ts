// core/inline-core.ts — THE INLINE CORE: reduce-only processors reduced SYNCHRONOUSLY at the
// stream's commit point. The runner apparatus (serial chain, cursors, gap repair, resurrection) is
// the price a facet pays for being AWAY from the commit point; these reduces run AT it and pay none
// of it — so a ReduceOnlyProcessor (contract + `reduce`, no `processEvent`) is hosted here for free.
//
// The whole engine is four moves: REHYDRATE from a versioned checkpoint (else the schema-initial
// state), CATCH UP to the durable head by replaying the log, REDUCE fresh durables at commit, and
// CHECKPOINT on change. A checkpoint is one versioned kv value per slug; rebuild replays the durable
// log — so version skew, eviction, and first contact are all the same path, and the checkpoint
// always rebuilds bit-identically (inline reduces see DURABLE events only). This module owns the
// cache + the four moves; the host (the stream DO) owns only the DEFS — which processors are inline
// — because building them (the capability table's whole built-in scope) is the host's wiring.
//
// A fifth, post-commit move makes the inline reduced states LIVE like every facet processor's:
// one LiveState per entry (key = the slug) emits the ephemeral live-state/changed delta after any
// commit whose reduce changed that entry — see publishLiveStateChanges below.

import { consumesEvent, type ReduceOnlyProcessor } from "./processor.ts";
import { readReduceCheckpoint, writeReduceCheckpoint } from "./reduce-checkpoint.ts";
import { LiveState, type LiveStateSink } from "./live-state.ts";
import type { StreamEvent } from "./events.ts";
import { reportIssue } from "./errors.ts";

type KvStore = { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
type Def = { slug: string; proc: ReduceOnlyProcessor<unknown> };
type Entry = { proc: ReduceOnlyProcessor<unknown>; state: unknown; throughOffset: number };

export class InlineCore {
  readonly #cache = new Map<string, Entry>();
  readonly #kv: KvStore;
  readonly #read: (
    after: number,
    limit: number,
  ) => { events: StreamEvent[]; scannedThroughOffset: number };
  readonly #head: () => number;
  readonly #defs: () => Def[];
  readonly #sink: LiveStateSink;
  /** ONE LiveState holder per inline entry (key = the slug), lazily born at the entry's first
   *  commit-time reduce SEEDED WITH THE PRE-BATCH STATE — so the first post-commit publish diffs
   *  exactly what the batch changed. The inline reduced states thereby produce the same ephemeral
   *  live-state/changed deltas facet processors already do (core/live-state.ts), and are
   *  subscribable via the existing `liveState:{key}` mode. */
  readonly #liveStates = new Map<string, LiveState<unknown>>();
  /** Slugs whose reduce changed state at the last commit — drained by publishLiveStateChanges. */
  readonly #changedAtCommit = new Set<string>();

  constructor(deps: {
    kv: KvStore;
    read: (after: number, limit: number) => { events: StreamEvent[]; scannedThroughOffset: number };
    head: () => number;
    /** Which processors are inline, built lazily (the capability table needs the host's scope). */
    defs: () => Def[];
    /** Where the live-state deltas land: the host's own append door (so a delta is admitted,
     *  committed, and fanned out like any other ephemeral event). */
    sink: LiveStateSink;
  }) {
    this.#kv = deps.kv;
    this.#read = deps.read;
    this.#head = deps.head;
    this.#defs = deps.defs;
    this.#sink = deps.sink;
  }

  /** The reduced state of an inline slug + how far it has folded — rehydrated (checkpoint, else
   *  initial) and caught up to the durable head. Synchronous: no chain, no cursor to persist here. */
  entry(slug: string): { state: unknown; throughOffset: number } {
    return this.#rehydrated(slug);
  }

  #rehydrated(slug: string): Entry {
    let entry = this.#cache.get(slug);
    if (!entry) {
      const def = this.#defs().find((d) => d.slug === slug);
      if (!def) throw new Error(`no inline processor "${slug}"`);
      const cp = readReduceCheckpoint(this.#kv, slug, def.proc.contract.version, () =>
        def.proc.contract.initialState(),
      );
      entry = cp
        ? { proc: def.proc, state: cp.state, throughOffset: cp.reducedThroughOffset }
        : { proc: def.proc, state: def.proc.contract.initialState(), throughOffset: 0 };
      this.#cache.set(slug, entry);
    }
    const head = this.#head();
    while (entry.throughOffset < head) {
      const page = this.#read(entry.throughOffset, 500);
      for (const e of page.events) if (e.offset <= head) this.#reduce(entry, e);
      entry.throughOffset = Math.min(page.scannedThroughOffset, head);
      if (page.events.length < 500) break;
    }
    return entry;
  }

  /** Reduce every FRESH durable event through each inline processor, checkpointing on change.
   *  Called INSIDE append's transaction (`after` = the pre-batch scanned offset). */
  reduceAtCommit(committed: StreamEvent[], after: number, nextOffset: number): void {
    for (const def of this.#defs()) {
      const entry = this.#rehydrated(def.slug); // caught up to the PRE-batch head (the cache is old)
      if (!this.#liveStates.has(def.slug))
        this.#liveStates.set(def.slug, new LiveState(this.#sink, def.slug, entry.state));
      const before = entry.state;
      for (const e of committed) {
        if (e.offset <= after || e.ephemeral) continue;
        this.#reduce(entry, e);
      }
      entry.throughOffset = nextOffset;
      // Inline writes ONLY on change (rebuild re-catches-up cheaply from the log, so an unadvanced
      // cursor is harmless) — unlike a facet, which advances its cursor every batch.
      if (entry.state !== before) {
        this.#changedAtCommit.add(def.slug); // published POST-commit — never inside the txn
        writeReduceCheckpoint(
          this.#kv,
          def.slug,
          { reducerVersion: def.proc.contract.version, reducedThroughOffset: nextOffset },
          entry.state,
          true,
        );
      }
    }
  }

  /** POST-COMMIT (the host's onCommit callback calls this — never inside the transaction): `set`
   *  each commit-changed entry's state on its LiveState, minting the standard ephemeral
   *  live-state/changed delta. LOSSY BY CONTRACT — LiveState.set contains every append refusal
   *  (a PAUSED stream refuses the ephemeral delta, for one) as a revision-chain gap the client
   *  heals by re-seeding; the pause window's changes simply never emit (the pause event's own
   *  delta included — the reduce paused the stream before its delta could be admitted). No
   *  feedback loop: live-state/changed is unconsumable (consumesEvent refuses it) and its commit
   *  changes no inline state, so at most one delta append chases each changing batch. The drained
   *  set is snapshotted BEFORE the sets: each set() appends — a nested commit whose own tail
   *  re-enters here and must find nothing left to publish. */
  publishLiveStateChanges(): void {
    if (this.#changedAtCommit.size === 0) return;
    const changed = [...this.#changedAtCommit];
    this.#changedAtCommit.clear();
    for (const slug of changed) {
      const entry = this.#cache.get(slug);
      const holder = this.#liveStates.get(slug);
      if (entry && holder) holder.set(entry.state);
    }
  }

  #reduce(entry: { proc: ReduceOnlyProcessor<unknown>; state: unknown }, e: StreamEvent): void {
    if (!consumesEvent(entry.proc.contract.consumes, e)) return;
    try {
      entry.state = entry.proc.reduce({ event: e, state: entry.state }) ?? entry.state;
    } catch (err) {
      reportIssue("inline-core.reduce", err, { slug: entry.proc.contract.slug, offset: e.offset });
    }
  }
}
