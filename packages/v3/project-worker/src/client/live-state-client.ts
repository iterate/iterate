// client/live-state-client.ts — wire an itx session's `subscribe` + a seed door to a LiveStateStore.
// This is the whole cleanroom client: `itx.subscribe({ liveState: { key }, target })` delivers each
// delta to the store; a `door` thunk reads `{rev, state}` for the first paint and every gap heal.
// Transport lives here so the store (client/live-state-store.ts) and the React hook stay pure.

import {
  createLiveStateStore,
  type LiveStateDelta,
  type LiveStateSeed,
  type LiveStateStore,
} from "./live-state-store.ts";

/** The slice of an itx session this needs — a capnweb `IterateContext` proxy satisfies it structurally. */
export type LiveItx = {
  subscribe(input: {
    name?: string;
    liveState: { key: string };
    target: (delta: unknown) => void;
  }): Promise<unknown>;
  unsubscribe(input: { name: string }): Promise<unknown>;
};

/** A connected live-state subscription: the store rendering it, and the dispose that tears the
 *  server-side subscription mount down (a mount outlives its socket by design — an undisposed
 *  connection leaks a durable mount per mount() call). */
export type LiveStateConnection<S> = {
  store: LiveStateStore<S>;
  /** Unsubscribe on the server and stop folding deltas. Safe to call more than once. */
  dispose(): Promise<void>;
};

/** Subscribe to a producer's live state and fold it into a store. `door` reads the seed
 *  (`itx.invokeCapability("itx.facets.get('slug').liveSnapshot()")` for a processor, or a mini-app's
 *  own `state()` method). Subscribe happens BEFORE the first seed, so a delta racing the seed just
 *  triggers one door re-read — never a lost update. Gap heals are SINGLE-FLIGHT (a burst of gapped
 *  frames triggers one door read, not one per frame); a failed heal is reported through `onResync`
 *  and retried by the next delivered delta (its `from` still mismatches, so it re-triggers). */
export async function connectLiveState<S>(
  itx: LiveItx,
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
  let disposed = false;
  const reseed = () => {
    if (healing || disposed) return;
    healing = true;
    void opts.door().then(
      (s) => {
        healing = false;
        if (disposed) return;
        store.seed(s);
        opts.onResync?.("healed");
      },
      (e: unknown) => {
        healing = false;
        if (disposed) return;
        opts.onResync?.(e instanceof Error ? e : new Error(String(e)));
      },
    );
  };
  const sub = (await itx.subscribe({
    name: opts.name,
    liveState: { key: opts.key },
    // capnweb hands the delta as a live proxy value — deep-copy to a plain object before folding.
    target: (delta: unknown) => {
      if (disposed) return;
      store.apply(JSON.parse(JSON.stringify(delta)) as LiveStateDelta, reseed);
    },
  })) as { name: string };
  store.seed(await opts.door());
  return {
    store,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await itx.unsubscribe({ name: sub.name }).catch(() => {
        // a dead session can't unsubscribe — the socket close already dropped the relay stub
      });
    },
  };
}
