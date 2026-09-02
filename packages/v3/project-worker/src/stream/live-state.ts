// stream/live-state.ts — THE live-state primitive: one value, its revision chain, and the diff→emit
// dance Phoenix LiveView does, over the project's stream. ONE module, used two ways:
//
//   • a mini-app DO (a chatroom, a lobby) owns one directly — `new LiveState(itx, "chat", {…})` —
//     and treats it as its store: `get()` reads, `set(next)` replaces (and notifies).
//   • the ProcessorEngine owns one per processor (stream/processor.ts): after every batch it
//     `set`s the current PROJECTION of the state, so a processor's reduced state is live by default,
//     and a processor reduces runtime fields into the projection (projectLiveState) — bumped inside
//     a batch they publish on their own; changed outside one, the host's publishLiveState() `set`s.
//
// MUTATION AND NOTIFICATION ARE INSEPARABLE: `set(next)` diffs the held value → next; on a real
// change it bumps the revision and appends the (ephemeral, unconsumable) live-state/changed delta
// carrying `{key, from, to, patch}` onto the stream. `snapshot()` is the SEED DOOR clients read
// `{rev, state}` through. The stream keeps no per-subscriber state for a push — and the
// CLIENT owns its chain: seed through the door, apply a payload whose `from` matches its held rev,
// re-read the door on any mismatch (live-state-chains-client-side.e2e is that whole loop).
//
// The revision is seeded from a per-incarnation EPOCH (not 0): a reborn holder mints a fresh epoch,
// so every stale client rev mismatches and re-reads the door instead of applying a patch onto a
// diverged base. Lossy by contract — a dropped delta append is a chain gap the client heals, never
// state loss (the durable truth is the reduced state; the runtime truth reseeds).

import { diff } from "../lib/patch.ts";

// THE one live-state change type is the literal "events.iterate.com/live-state/changed" — ephemeral,
// payload `{key, from, to, patch}`: the delta patch rides the event (LiveView-style), chained by
// producer-owned revisions (`from` = the previous emission's `to`). HARD RULE: no processor can ever
// REDUCE it (the engine's `reducesEvent` refuses it before contracts are consulted), so state-change
// notifications can never feed a reduce — the feedback-loop class is unspellable, not discouraged.
// A SUBSCRIPTION may name the type to watch live state; that is delivery, not a reduce.

/** The only thing a LiveState needs from its host: somewhere to append the delta. Both a
 *  `ProcessorStream` (`this.stream`) and the itx scope (`env.ITX`) satisfy it — the shape is the
 *  StreamEventInput subset a delta uses (ephemeral is always literal `true`). */
export type LiveStateSink = {
  append(event: { type: string; ephemeral?: true; payload?: Record<string, unknown> }): unknown;
};

export class LiveState<S> {
  readonly #sink: LiveStateSink;
  readonly #key: string;
  #state: S;
  /** The DIFF BASE: the last value that serialized — what a client that applied every delta holds.
   *  Kept apart from `#state` so a value the wire cannot carry, adopted without an emit, never
   *  becomes the base every later diff would throw against. */
  #lastSerializedState: S;
  #rev: number;

  constructor(sink: LiveStateSink, key: string, initial: S) {
    this.#sink = sink;
    this.#key = key;
    this.#state = initial;
    this.#lastSerializedState = initial;
    this.#rev = Date.now() * 4096 + Math.floor(Math.random() * 4096);
  }

  /** The current value (reflects every `set`). */
  get(): S {
    return this.#state;
  }

  /** THE seed door: `{rev, state}` read together (single-threaded ⇒ atomically), which is what lets
   *  a client chain patches exactly instead of guessing which changes its snapshot already contains. */
  snapshot(): { rev: number; state: S } {
    return { rev: this.#rev, state: this.#state };
  }

  /** Replace the value: diff the last serialized base → next; on a real change bump the revision
   *  and append the delta. Build a NEW value (don't mutate `next` in place) — the diff is over JSON.
   *  A diff/append failure degrades to a LOST notification (the client re-seeds on the chain gap),
   *  never a throw the caller sees. */
  set(next: S): void {
    // The diff is JSON.stringify on both sides (lib/patch.ts), so a `next` the wire cannot carry (a
    // BigInt, a cycle) throws HERE and nowhere later: adopt it anyway, and STILL advance the rev —
    // the base moved without an emit, and the bump is what mints the chain gap that forces a stale
    // client's re-seed (without it, a later emit's `from` would match the client's held rev and it
    // would apply a patch computed against a base it never received: silent corruption). The
    // serialized base stays put, so the next serializable value emits as a diff from what the client
    // last saw.
    let patch;
    try {
      patch = diff(this.#lastSerializedState, next);
    } catch {
      this.#state = next;
      this.#rev += 1;
      return;
    }
    this.#state = next;
    this.#lastSerializedState = next;
    if (!patch) return;
    const from = this.#rev;
    this.#rev = from + 1;
    // Both a sync throw and a rejection land in the same lossy contract: a dropped change payload
    // is a revision-chain gap the client heals (the rev already advanced above).
    try {
      void Promise.resolve(
        this.#sink.append({
          type: "events.iterate.com/live-state/changed",
          ephemeral: true,
          payload: { key: this.#key, from, to: this.#rev, patch },
        }),
      ).catch(() => {});
    } catch {
      /* same gap */
    }
  }
}
