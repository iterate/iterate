// stream/inline-reduce.ts — THE INLINE HOST: one `StreamProcessor` (the core reduce,
// core-processor.ts) reduced SYNCHRONOUSLY at the stream's commit point. The engine apparatus a
// facet pays for (serial chain, cursors, gap repair) is the price of being AWAY from the commit
// point; this reduce runs AT it and pays none of it. Only `reduce` is ever called here, so a
// processor that overrides `processEvent` is REFUSED at construction (its effects would silently
// never run) — the reduce-only rule, checked where it matters.
//
// Four moves: REHYDRATE from a versioned checkpoint (else the schema-initial state), CATCH UP to
// the durable head by replaying the log, REDUCE fresh durables at commit, and CHECKPOINT — the
// cursor every durable batch (a ~1 µs kv put inside the transaction already open), the state only
// when it changed. The checkpoint is one versioned kv pair (reduce-checkpoint.ts); rebuild replays
// the durable log — so version skew, eviction, and first contact are all the same path, and the
// checkpoint always rebuilds bit-identically (inline reduces see DURABLE events only). The cursor
// write is what bounds a wake: without it a long incarnation's whole log replayed on the first call
// after eviction (measured 0.4–1.2 s per million rows).
//
// A fifth, post-commit move makes the reduced state LIVE like every facet processor's: one LiveState
// (key = the slug) emits the ephemeral live-state/changed delta after any commit whose reduce changed
// the state — see publishLiveStateChange.

import { reportIssue } from "../lib/errors.ts";
import { consumesEvent, StreamProcessor } from "./processor.ts";
import { readReduceCheckpoint, writeReduceCheckpoint } from "./reduce-checkpoint.ts";
import { LiveState, type LiveStateSink } from "./live-state.ts";
import type { StreamEvent } from "./events.ts";

type KvStore = { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
type Entry<State> = { state: State; throughOffset: number };

export class InlineReduce<State> {
  readonly #proc: StreamProcessor<State>;
  readonly #kv: KvStore;
  readonly #read: (
    after: number,
    limit: number,
  ) => { events: StreamEvent[]; scannedThroughOffset: number };
  readonly #head: () => number;
  readonly #sink: LiveStateSink;
  #entry?: Entry<State>;
  /** ONE LiveState holder, lazily born at the first commit-time reduce SEEDED WITH THE PRE-BATCH
   *  STATE — so the first post-commit publish diffs exactly what the batch changed. A subscription
   *  names `events.iterate.com/live-state/changed` to watch it, `payload.key` = the slug. */
  #live?: LiveState<State>;
  /** Did the last commit's reduce change the state? Drained by publishLiveStateChange. */
  #changedAtCommit = false;

  constructor(
    proc: StreamProcessor<State>,
    deps: {
      kv: KvStore;
      read: (
        after: number,
        limit: number,
      ) => { events: StreamEvent[]; scannedThroughOffset: number };
      /** The DURABLE high-water mark: the reduce folds durables only, so this is its head. Never the
       *  in-memory head — that counts ephemeral offsets, and chasing it would issue a log read on
       *  every call after an ephemeral commit. */
      head: () => number;
      /** Where the live-state deltas land: the host's own append door (so a delta is admitted,
       *  committed, and fanned out like any other ephemeral event). */
      sink: LiveStateSink;
    },
  ) {
    // THE REDUCE-ONLY RULE: hosted here only `reduce` ever runs. A processor with effects must be a
    // facet (the engine drives its processEvent); hosting it inline would silently drop them.
    if (proc.processEvent !== StreamProcessor.prototype.processEvent)
      throw new Error(
        `inline processor "${proc.contract.slug}" overrides processEvent — effects never run at the commit point; host it as a facet`,
      );
    this.#proc = proc;
    this.#kv = deps.kv;
    this.#read = deps.read;
    this.#head = deps.head;
    this.#sink = deps.sink;
  }

  /** The reduced state + how far it has folded — rehydrated (checkpoint, else initial) and caught up
   *  to the durable head. Synchronous: no chain, no cursor to persist here. */
  entry(): Entry<State> {
    const { contract } = this.#proc;
    if (!this.#entry) {
      const cp = readReduceCheckpoint<State>(this.#kv, contract.slug, contract.version, () =>
        contract.initialState(),
      );
      this.#entry = cp
        ? { state: cp.state, throughOffset: cp.reducedThroughOffset }
        : { state: contract.initialState(), throughOffset: 0 };
    }
    const entry = this.#entry;
    const head = this.#head();
    while (entry.throughOffset < head) {
      const page = this.#read(entry.throughOffset, 500);
      for (const e of page.events) if (e.offset <= head) this.#reduce(entry, e);
      entry.throughOffset = Math.min(page.scannedThroughOffset, head);
      if (page.events.length < 500) break;
    }
    return entry;
  }

  /** The live-state SEED — `{ rev, state }` in step with the deltas the holder emits (the same door
   *  a facet processor's `liveSnapshot()` is). Before the first commit of an incarnation there is
   *  no holder yet: rev 0 over the caught-up state, which is exactly what the first delta
   *  (`from: 0`) will chain onto. */
  liveSnapshot(): { rev: number; state: State } {
    const entry = this.entry();
    return this.#live?.snapshot() ?? { rev: 0, state: entry.state };
  }

  /** Reduce every FRESH durable event, checkpointing on change. Called INSIDE append's transaction
   *  (`after` = the pre-batch scanned offset). */
  reduceAtCommit(committed: StreamEvent[], after: number, nextOffset: number): void {
    const entry = this.entry(); // caught up to the PRE-batch head (the cache is old)
    this.#live ??= new LiveState(this.#sink, this.#proc.contract.slug, entry.state);
    const before = entry.state;
    for (const e of committed) {
      if (e.offset <= after || e.ephemeral) continue;
      this.#reduce(entry, e);
    }
    entry.throughOffset = nextOffset;
    // The cursor every batch, the state on change (see the header): this runs inside append's
    // transaction, which this batch's durable rows already opened, so the cursor put is free.
    const changed = entry.state !== before;
    if (changed) this.#changedAtCommit = true; // published POST-commit — never inside the txn
    writeReduceCheckpoint(
      this.#kv,
      this.#proc.contract.slug,
      { reducerVersion: this.#proc.contract.version, reducedThroughOffset: nextOffset },
      entry.state,
      changed,
    );
  }

  /** POST-COMMIT (the host's onCommit callback calls this — never inside the transaction): `set`
   *  the commit-changed state on the LiveState, minting the standard ephemeral live-state/changed
   *  delta. LOSSY BY CONTRACT — LiveState.set contains every append refusal (a PAUSED stream refuses
   *  the ephemeral delta, for one) as a revision-chain gap the client heals by re-seeding; the pause
   *  window's changes simply never emit (the pause event's own delta included). No feedback loop:
   *  live-state/changed is ephemeral (never reaches this reduce) and its commit changes no core
   *  state, so at most one delta append chases each changing batch. The flag is cleared BEFORE the
   *  set: set() appends — a nested commit whose own tail re-enters here and must find nothing left. */
  publishLiveStateChange(): void {
    if (!this.#changedAtCommit) return;
    this.#changedAtCommit = false;
    if (this.#entry && this.#live) this.#live.set(this.#entry.state);
  }

  #reduce(entry: Entry<State>, e: StreamEvent): void {
    if (!consumesEvent(this.#proc.contract.consumes, e)) return;
    try {
      entry.state = this.#proc.reduce({ event: e, state: entry.state }) ?? entry.state;
    } catch (err) {
      reportIssue("inline-reduce.reduce", err, {
        slug: this.#proc.contract.slug,
        offset: e.offset,
      });
    }
  }
}
