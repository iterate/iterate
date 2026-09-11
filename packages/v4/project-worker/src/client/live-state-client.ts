// client/live-state-client.ts — wire an itx session's `subscribe` + a seed door to a LiveStateStore.
// This is the whole cleanroom client: a subscription that consumes the one live-state event type
// (`itx.subscribe({ target, consumes: ["events.iterate.com/live-state/changed"] })`) delivers every
// key's deltas in batches; this filters the watched `key` and reduces each delta into the store; a
// `door` thunk reads `{rev, state}` for the first paint and every gap heal. Transport lives here so
// the store (client/live-state-store.ts) and the React hook stay pure.

import {
  createLiveStateStore,
  type LiveStateDelta,
  type LiveStateSeed,
  type LiveStateStore,
} from "./live-state-store.ts";

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
  store.seed(await opts.door());
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
