// stream/live-state.ts — THE live-state primitive: one value, its revision chain, and the diff→emit
// dance Phoenix LiveView does, over the project's stream. Used two ways: a mini-app DO owns one
// directly as its store; the ProcessorEngine owns one per processor and `set`s the projection after
// every batch (sdk/index.ts shows both).
//
// MUTATION AND NOTIFICATION ARE INSEPARABLE: `set(next)` diffs the held value → next; on a real
// change it bumps the revision and appends the ephemeral `live-state/changed` delta carrying
// `{key, from, to, patch}` onto the stream. `snapshot()` is the SEED DOOR. The stream keeps no
// per-subscriber state — the CLIENT owns its chain: seed through the door, apply a payload whose
// `from` matches its held rev, re-read the door on any mismatch (live-state-chains-client-side.e2e).
//
// The revision is seeded from a per-incarnation EPOCH (not 0): a reborn holder mints a fresh epoch,
// so every stale client rev mismatches and re-reads the door instead of applying a patch onto a
// diverged base. Lossy by contract — a dropped delta append is a chain gap the client heals, never
// state loss. HARD RULE: no processor can ever REDUCE the delta (processor.ts `reducesEvent`), so a
// state-change notification can never feed a reduce; a SUBSCRIPTION may name the type to watch it.

import { diff } from "../lib/patch.ts";

/** A delta whose patch is over this many chars is not sent: a whole-array replace of a large
 *  projection would cost every watcher the projection per set, and past the event ceiling the door
 *  would refuse it outright. The delta rides with `patch: null` instead — the rev moved, re-seed. */
const LIVE_STATE_PATCH_MAX_CHARS = 1024 * 1024;

/** The only thing a LiveState needs from its host: somewhere to append the delta. A
 *  `ProcessorStream` and the itx scope both satisfy it. */
export type LiveStateSink = {
  append(event: { type: string; ephemeral?: true; payload?: Record<string, unknown> }): unknown;
};

export class LiveState<S> {
  readonly #liveStateSink: LiveStateSink;
  readonly #liveStateKey: string;
  #state: S;
  /** The DIFF BASE: the last value that serialized — what a client that applied every delta holds.
   *  Kept apart from `#state` so a value the wire cannot carry, adopted without an emit, never
   *  becomes the base every later diff would throw against. */
  #lastSerializedState: S;
  #liveStateRev: number;
  /** THE DELTA APPEND CHAIN — at most one delta append in flight, so commit order = mint order for a
   *  CROSS-HOP sink: `env.ITX.get().append(e)` mints a FRESH capability per call, so two deltas
   *  issued in different turns race across the hop and the second can commit first — ~14% of rapid
   *  pairs on the deployed edge (never locally, the hop is sub-ms). Nothing is dropped by a reorder,
   *  but it costs every watcher the full door re-read the deltas exist to avoid. A lone delta (the
   *  chain idle) is issued synchronously; only when an append is already in flight does the next
   *  queue behind it. Nobody waits on this. */
  #liveStateDeltaAppendChain: Promise<unknown> = Promise.resolve();
  #liveStateDeltaAppendInFlight = false;
  /** Whether to order delta appends across turns (above). TRUE by default, so a mini-app holder gets
   *  it without opting in. FALSE for the core reduce, whose sink is the stream's OWN synchronous
   *  `append` (same isolate, no reorder possible): there the delta must land densely inside the
   *  commit that triggered it, never deferred a microtask. */
  readonly #orderDeltaAppends: boolean;

  constructor(
    sink: LiveStateSink,
    key: string,
    initial: S,
    options?: { orderDeltaAppends?: boolean },
  ) {
    this.#liveStateSink = sink;
    this.#liveStateKey = key;
    this.#state = initial;
    this.#lastSerializedState = initial;
    this.#liveStateRev = Date.now() * 4096 + Math.floor(Math.random() * 4096);
    this.#orderDeltaAppends = options?.orderDeltaAppends ?? true;
  }

  /** The current value (reflects every `set`). */
  get(): S {
    return this.#state;
  }

  /** THE seed door: `{rev, state}` read together (single-threaded ⇒ atomically), which is what lets
   *  a client chain patches exactly instead of guessing which changes its snapshot already contains. */
  snapshot(): { rev: number; state: S } {
    return { rev: this.#liveStateRev, state: this.#state };
  }

  /** Replace the value: diff the last serialized base → next; on a real change bump the revision
   *  and append the delta. Build a NEW value (don't mutate `next` in place) — the diff is over JSON.
   *  A diff/append failure degrades to a LOST notification (the client re-seeds on the chain gap),
   *  never a throw the caller sees. */
  set(next: S): void {
    // The SAME object is the same JSON (the contract forbids in-place mutation, which is what makes
    // identity a proof of equality): no diff, no delta, no rev move — the common case for a
    // processor whose projection is its unchanged reduced state.
    if (next === this.#lastSerializedState) return;
    // A `next` the wire cannot carry (a BigInt, a cycle) throws in the diff: adopt it anyway, and
    // STILL advance the rev — the bump mints the chain gap that forces a stale client's re-seed
    // (without it, a later emit's `from` would match the client's held rev and it would apply a
    // patch computed against a base it never received: silent corruption). The serialized base
    // stays put, so the next serializable value emits as a diff from what the client last saw.
    let patch;
    try {
      patch = diff(this.#lastSerializedState, next);
    } catch {
      this.#state = next;
      this.#liveStateRev += 1;
      return;
    }
    this.#state = next;
    this.#lastSerializedState = next;
    if (!patch) return;
    const from = this.#liveStateRev;
    const to = from + 1; // a LOCAL: a later set's rev must not be read into this delta's payload
    this.#liveStateRev = to;
    const wirePatch = JSON.stringify(patch).length > LIVE_STATE_PATCH_MAX_CHARS ? null : patch;
    const emitDelta = () =>
      this.#liveStateSink.append({
        type: "events.iterate.com/live-state/changed",
        ephemeral: true,
        payload: { key: this.#liveStateKey, from, to, patch: wirePatch },
      });
    // A dropped delta — a sync throw or a rejection — is a chain gap the client heals (the rev
    // already advanced); it must never reach the caller.
    if (!this.#orderDeltaAppends) {
      // The same-isolate sink: synchronously and densely, every time (`#orderDeltaAppends`).
      try {
        void Promise.resolve(emitDelta()).catch(() => {});
      } catch {
        /* the gap, contained */
      }
      return;
    }
    if (this.#liveStateDeltaAppendInFlight) {
      // A rapid cross-hop pair: queue behind the in-flight append, in mint order.
      this.#liveStateDeltaAppendChain = this.#liveStateDeltaAppendChain
        .then(emitDelta)
        .catch(() => {});
      return;
    }
    // The chain is idle: emit SYNCHRONOUSLY; the flag tracks a cross-hop sink's pending promise.
    this.#liveStateDeltaAppendInFlight = true;
    this.#liveStateDeltaAppendChain = (() => {
      try {
        return Promise.resolve(emitDelta()).catch(() => {});
      } catch {
        return Promise.resolve(); // a synchronously-throwing sink: the gap, contained
      }
    })().finally(() => {
      this.#liveStateDeltaAppendInFlight = false;
    });
  }

  /** Every delta minted so far has reached the sink (or failed into the chain gap) — the test seam
   *  for LiveState's now-asynchronous append (the delta append chain). Production never awaits it. */
  deltasSettled(): Promise<unknown> {
    return this.#liveStateDeltaAppendChain;
  }
}
