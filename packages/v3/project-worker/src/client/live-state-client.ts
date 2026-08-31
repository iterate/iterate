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

/** The slice of an itx session this needs — a capnweb `Itx` proxy satisfies it structurally. */
export type LiveItx = {
  subscribe(input: {
    name?: string;
    liveState: { key: string };
    target: (delta: unknown) => void;
  }): Promise<unknown>;
};

/** Subscribe to a producer's live state and fold it into a store. `door` reads the seed
 *  (`itx.invokeCapability("itx.facets.get('slug').liveSnapshot()")` for a processor, or a mini-app's
 *  own `state()` method). Subscribe happens BEFORE the first seed, so a delta racing the seed just
 *  triggers one door re-read — never a lost update. */
export async function connectLiveState<S>(
  itx: LiveItx,
  opts: { key: string; name?: string; door: () => Promise<LiveStateSeed<S>> },
): Promise<LiveStateStore<S>> {
  const store = createLiveStateStore<S>();
  const reseed = () =>
    void opts.door().then(
      (s) => store.seed(s),
      () => {},
    );
  await itx.subscribe({
    name: opts.name,
    liveState: { key: opts.key },
    // capnweb hands the delta as a live proxy value — deep-copy to a plain object before folding.
    target: (delta: unknown) =>
      store.apply(JSON.parse(JSON.stringify(delta)) as LiveStateDelta, reseed),
  });
  store.seed(await opts.door());
  return store;
}
