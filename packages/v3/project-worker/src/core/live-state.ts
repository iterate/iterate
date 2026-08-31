// core/live-state.ts — THE live-state primitive: one value, its revision chain, and the diff→emit
// dance Phoenix LiveView does, over the project's stream. ONE module, used two ways:
//
//   • a mini-app DO (a chatroom, a lobby) owns one directly — `new LiveState(itx, "chat", {…})` —
//     and treats it as its store: `get()` reads, `set(next)` replaces (and notifies).
//   • the StreamProcessor base owns one per processor (core/processor.ts): after every reduce it
//     `set`s the current PROJECTION of its state, so a processor's reduced state is live by default,
//     and a processor can fold runtime fields into the projection (projectLiveState) and `set` again
//     out of band (publishLiveState) when one changes.
//
// MUTATION AND NOTIFICATION ARE INSEPARABLE: `set(next)` diffs the held value → next; on a real
// change it bumps the revision and appends the (ephemeral, unconsumable) LIVE_STATE_CHANGED delta
// carrying `{key, from, to, patch}` onto the stream. `snapshot()` is the SEED DOOR clients read
// `{rev, state}` through. The stream is a pure forwarder — no per-subscriber server state — and the
// CLIENT owns its chain: seed through the door, apply a payload whose `from` matches its held rev,
// re-read the door on any mismatch (prove_livestate.mjs is that whole loop).
//
// The revision is seeded from a per-incarnation EPOCH (not 0): a reborn holder mints a fresh epoch,
// so every stale client rev mismatches and re-reads the door instead of applying a patch onto a
// diverged base. Lossy by contract — a dropped delta append is a chain gap the client heals, never
// state loss (the durable truth is the reduced fold; the runtime truth reseeds).

import { diff } from "./patch.ts";

/** THE one live-state change type — ephemeral, payload `{key, from, to, patch}`: the delta patch
 *  rides the event (LiveView-style), chained by producer-owned revisions (`from` = the previous
 *  emission's `to`). HARD RULE: no processor can ever consume it (consumesEvent refuses it before
 *  contracts are consulted), so state-change notifications can never feed a reduce — the
 *  feedback-loop class is unspellable, not merely discouraged. */
export const LIVE_STATE_CHANGED = "events.iterate.com/live-state/changed";

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
  #rev: number;

  constructor(sink: LiveStateSink, key: string, initial: S) {
    this.#sink = sink;
    this.#key = key;
    this.#state = initial;
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

  /** Replace the value: diff held→next; on a real change bump the revision and append the delta.
   *  Build a NEW value (don't mutate `next` in place) — the diff is over JSON, held identity is the
   *  baseline. A projection/diff/append failure degrades to a LOST notification (the client re-seeds
   *  on the chain gap), never a throw the caller sees. */
  set(next: S): void {
    // The value is adopted whatever happens; only the NOTIFICATION is best-effort. A projection the
    // wire can't carry (a BigInt, a cycle) throws in `diff` — contain it here so a batch/set caller
    // never sees it; the client re-seeds on the resulting chain gap.
    let patch;
    try {
      patch = diff(this.#state, next);
    } catch {
      this.#state = next;
      return;
    }
    this.#state = next;
    if (!patch) return;
    const from = this.#rev;
    this.#rev = from + 1;
    void Promise.resolve(
      this.#sink.append({
        type: LIVE_STATE_CHANGED,
        ephemeral: true,
        payload: { key: this.#key, from, to: this.#rev, patch },
      }),
    ).catch(() => {
      /* lossy by contract — a dropped change payload is a revision-chain gap the client heals */
    });
  }
}
