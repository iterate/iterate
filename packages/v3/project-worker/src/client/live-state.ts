// client/live-state.ts — THE CLIENT HALF of live state (`project-worker/client`), framework-free, for
// browsers and node test clients. Two concepts:
//   live state store  — `createLiveStateStore`: the pure reduce — seed through the door, apply each delta, heal on a gap
//   live state client — `connectLiveState`: wire an itx session's `subscribe` + a seed door to the store

import { applyPatch, type PatchOp } from "../lib.ts";

// ── live state store ── THE CLIENT HALF of live state, for browsers and node test clients.
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
// The patch format is lib.ts (an RFC-6902 subset), so this store shares ONE applyPatch with
// the producer — no second diff implementation. No capnweb import: a caller wires the transport and
// hands deltas in, so the same store backs a node test client and the React hook (client/demo.tsx).

/** One live-state delta off the wire — the payload of an `events.iterate.com/live-state/changed`
 *  ephemeral event, delivered raw to the subscriber. */
/** `patch: null` = the change was too large to send — the rev moved, re-seed through the door. */
export type LiveStateDelta = { key: string; from: number; to: number; patch: PatchOp[] | null };

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
      // reborn epoch, and a `null` patch means the change was too large to send — either way re-read
      // the door instead of applying onto a diverged base.
      if (delta.from !== held.rev || delta.patch === null) {
        resync();
        return;
      }
      held = { rev: delta.to, state: applyPatch(held.state as S, delta.patch) };
      notify();
    },
  };
}

// ── live state client ── wire an itx session's `subscribe` + a seed door to a LiveStateStore.
// This is the whole cleanroom client: a subscription that consumes the one live-state event type
// (`itx.subscribe({ target, consumes: ["events.iterate.com/live-state/changed"] })`) delivers every
// key's deltas in batches; this filters the watched `key` and reduces each delta into the store; a
// `door` thunk reads `{rev, state}` for the first paint and every gap heal. Transport lives here so
// the store (client/live-state.ts) and the React hook stay pure.

/** The slice of an itx session this needs — a capnweb `IterateContext` proxy satisfies it structurally:
 *  `subscribe` hands back a DISPOSABLE handle (disposing it removes the subscription server-side). */
export type LiveStateItx = {
  subscribe(input: {
    name?: string;
    consumes?: string[];
    target: (events: unknown[], range: unknown) => void;
  }): Promise<{ [Symbol.dispose](): void }>;
};

/** A connected live-state subscription: the store rendering it, and the dispose that removes the
 *  server-side subscription (the handle's disposer; the session's end does the same). */
export type LiveStateConnection<S> = {
  store: LiveStateStore<S>;
  /** Unsubscribe on the server and stop reducing deltas. Safe to call more than once. */
  dispose(): Promise<void>;
};

/** Subscribe to a producer's live state and reduce it into a store. `door` reads the seed
 *  (`itx.invoke("itx.facets.get('slug').liveSnapshot()")` for a processor, or a mini-app's
 *  own `state()` method). Subscribe happens BEFORE the first seed, so a delta racing the seed just
 *  triggers one door re-read — never a lost update. Gap heals are SINGLE-FLIGHT (a burst of gapped
 *  frames triggers one door read, not one per frame); a failed heal is reported through `onResync`
 *  and retried by the next delivered delta (its `from` still mismatches, so it re-triggers). */
export async function connectLiveState<S>(
  itx: LiveStateItx,
  opts: {
    key: string;
    name?: string;
    door: () => Promise<LiveStateSeed<S>>;
    /** Called after each gap heal attempt: "healed" on a fresh seed, the error when the door read
     *  failed (the store keeps its last value; the next delta retries). */
    onResync?: (result: "healed" | Error) => void;
    /** Abort while the FIRST seed is still pending (a component unmounting): the row just configured
     *  is recalled and the connect rejects — a door that never answers leaves nothing lent. */
    signal?: AbortSignal;
  },
): Promise<LiveStateConnection<S>> {
  const store = createLiveStateStore<S>();
  let healing = false;
  let healWantedAgain = false; // a gap seen WHILE a heal was in flight: the seed may predate it
  let disposed = false;
  const reseed = () => {
    if (disposed) return;
    if (healing) {
      healWantedAgain = true;
      return;
    }
    healing = true;
    const settled = () => {
      healing = false;
      if (disposed || !healWantedAgain) return;
      healWantedAgain = false;
      reseed();
    };
    void opts.door().then(
      (s) => {
        if (!disposed) {
          store.seed(s);
          opts.onResync?.("healed");
        }
        settled();
      },
      (e: unknown) => {
        if (!disposed) opts.onResync?.(e instanceof Error ? e : new Error(String(e)));
        settled();
      },
    );
  };
  const subscription = await itx.subscribe({
    name: opts.name,
    consumes: ["events.iterate.com/live-state/changed"],
    // A batch of live-state deltas (every key's); keep the watched key's. capnweb hands each event
    // as a live proxy value — deep-copy to a plain object before reducing.
    target: (events: unknown[]) => {
      if (disposed) return;
      for (const e of events) {
        const delta = JSON.parse(
          JSON.stringify((e as { payload: unknown }).payload),
        ) as LiveStateDelta;
        if (delta.key === opts.key) store.apply(delta, reseed);
      }
    },
  });
  try {
    const seed = opts.door();
    const { signal } = opts;
    const aborted =
      signal &&
      new Promise<never>((_, reject) => {
        const abort = () =>
          reject(
            signal.reason ??
              new Error("connectLiveState: aborted while the first seed was pending"),
          );
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    if (aborted) seed.catch(() => undefined); // the door may still settle after the abort — quietly
    store.seed(await (aborted ? Promise.race([seed, aborted]) : seed));
  } catch (error) {
    // The seed failed after the row was configured: recall it, or the server keeps delivering to a
    // callback no one holds (and the session's other rows wait behind it).
    disposed = true;
    try {
      subscription[Symbol.dispose]();
    } catch {
      // a dead session has already removed it
    }
    throw error;
  }
  return {
    store,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        subscription[Symbol.dispose](); // the server removes the row and recalls the lent callback
      } catch {
        // a dead session has already removed it — the socket close disposed every handle
      }
    },
  };
}
