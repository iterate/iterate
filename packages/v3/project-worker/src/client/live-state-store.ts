// client/live-state-store.ts — THE CLIENT HALF of live state, for browsers and node test clients.
// Adapted from apps/os's `createLiveStateStore` (packages/iterate/src/sdk/capnweb/live-state), kept
// deliberately tiny, and pointed at the CLEAN-ROOM wire instead of apps/os's in-band snapshot:
//
//   • SEED through the producer's door — `{rev, state}` read via an RPC method (a processor's
//     `liveSnapshot()`, a mini-app's `state()`). apps/os reduces the first snapshot in-band on the
//     subscription; here the stream keeps no per-subscriber state, so the seed is a separate read.
//   • APPLY each `{key, from, to, patch}` delta the subscription delivers: a patch lands only when
//     its `from` matches the held rev; a mismatch means a missed delta (or a reborn producer's fresh
//     epoch) — resync by re-reading the door, exactly like apps/os's revision-gap resync.
//
// The patch format is lib/patch.ts (an RFC-6902 subset), so this store shares ONE applyPatch with
// the producer — no second diff implementation. No capnweb import: a caller wires the transport and
// hands deltas in, so the same store backs a node test client and the React hook (client/react.tsx).

import { applyPatch, type PatchOp } from "../lib/patch.ts";

/** One live-state delta off the wire — the payload of an `events.iterate.com/live-state/changed`
 *  ephemeral event, delivered raw to the subscriber. */
export type LiveStateDelta = { key: string; from: number; to: number; patch: PatchOp[] };

/** What the producer's seed door returns: the current revision paired with the current value. */
export type LiveStateSeed<S> = { rev: number; state: S };

export type LiveStateStore<S> = {
  /** The current value, or undefined until the first seed lands. */
  get(): S | undefined;
  /** The held revision, or null before the first seed. */
  rev(): number | null;
  /** Subscribe to changes (for React's useSyncExternalStore, or a test's await-loop). */
  subscribe(listener: () => void): () => void;
  /** Seed (or re-seed) from the door — the first paint, and the heal after a gap. */
  seed(seed: LiveStateSeed<S>): void;
  /** Reduce one delta in; on a revision gap call `resync` and hold the value until a fresh seed. */
  apply(delta: LiveStateDelta, resync: () => void): void;
};

export function createLiveStateStore<S>(): LiveStateStore<S> {
  // `rev: null` until the first seed lands.
  let held: { rev: number | null; state: S | undefined } = { rev: null, state: undefined };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    get: () => held.state,
    rev: () => held.rev,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    seed: (seed) => {
      // MONOTONIC: a late-resolving OLDER door read must never move the store backwards past state
      // deltas have already advanced (a delta-triggered resync can race the initial seed). Revisions
      // are time-seeded epochs plus increments, so "newer" is numeric.
      if (held.rev !== null && seed.rev < held.rev) return;
      held = { rev: seed.rev, state: seed.state };
      notify();
    },
    apply: (delta, resync) => {
      // A delta at-or-behind the held rev is a duplicate/out-of-order frame — drop it silently.
      // (Epochs are minted from the clock, so a reborn producer's fresh chain sits numerically above
      // every rev an old chain handed out; a frame wholly behind us is genuinely old. The one
      // exception is a clock that regressed across a producer rebirth — accepted: the next applied
      // or gapped frame resyncs through the door anyway.)
      if (held.rev !== null && delta.to <= held.rev) return;
      // A gap (its `from` is not the held rev — including "no seed yet") means a missed delta or a
      // reborn epoch — re-read the door instead of applying onto a diverged base.
      if (delta.from !== held.rev) {
        resync();
        return;
      }
      held = { rev: delta.to, state: applyPatch(held.state as S, delta.patch) };
      notify();
    },
  };
}
