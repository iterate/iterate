// reduce-checkpoint.ts — THE ONE spelling of a persisted reduce checkpoint, shared by BOTH hosts:
// the INLINE reduce-only processors (`core`, `capability-table` — reduced synchronously at the
// commit point in iterate-context-durable-object.ts) and the FACET runner (StreamProcessor, driven away from
// the commit point in processor.ts). Before this, each host had its own type, key layout, and
// read/write logic for the same concept.
//
// TWO keys on purpose (not one blob): a tiny CURSOR (`reducerVersion` + `reducedThroughOffset`) and
// the STATE blob. The cursor is cheap to write; the state is written ONLY when the reduce actually
// changed it, so an unchanged batch never rewrites the whole state. An ABSENT state key with a
// matching cursor means the reduce never changed state = `initialState()` (a pure side-effect
// processor; reusing the cursor stops it re-firing its whole effect history on every rebuild).
//
// The two hosts differ ONLY in WRITE CADENCE, and that difference is legitimate (it lives at the
// call sites, not here): the facet advances the cursor on EVERY durable batch (it is distant and
// re-running effects on rebuild is expensive/wrong); the inline host writes only ON CHANGE (it
// rebuilds cheaply from the log at the commit point, so an unadvanced cursor just re-catches-up).

/** A reduce processor's persisted position: the contract version it was reduced under, the offset
 *  it has reduced through, and the reduced state. The in-memory shape both hosts hold. */
export type ReduceCheckpoint<State> = {
  reducerVersion: string;
  reducedThroughOffset: number;
  state: State;
};

/** The minimal durable kv both hosts expose (`ProcessorStorage` and `ctx.storage.kv` both satisfy). */
type CheckpointStore = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
};

/** The cursor key — read directly by the facet's version-refold probe. */
export const reduceCursorKey = (slug: string): string => `reduce:${slug}:progress`;
export const reduceStateKey = (slug: string): string => `reduce:${slug}:state`;

/** Read the persisted checkpoint for `slug`, or `undefined` when there is no cursor OR the stored
 *  cursor's version doesn't match — the caller then rebuilds from offset 0 (a version refold / cold
 *  catch-up). Returning undefined (not a fresh checkpoint) is deliberate: the caller must NOT cache
 *  the fresh fallback, or the refold it triggers would be skipped and replay the whole log. */
export function readReduceCheckpoint<State>(
  store: CheckpointStore,
  slug: string,
  version: string,
  initialState: () => State,
): ReduceCheckpoint<State> | undefined {
  const cursor = store.get<{ reducerVersion: string; reducedThroughOffset: number }>(
    reduceCursorKey(slug),
  );
  if (!cursor || cursor.reducerVersion !== version) return undefined;
  const state = store.get<State>(reduceStateKey(slug));
  return {
    reducerVersion: cursor.reducerVersion,
    reducedThroughOffset: cursor.reducedThroughOffset,
    state: state !== undefined ? state : initialState(),
  };
}

/** Persist a checkpoint: ALWAYS the cursor, the state blob ONLY when `stateChanged`. Both land in
 *  one event-loop turn, so the storage write coalescer commits them together. */
export function writeReduceCheckpoint<State>(
  store: CheckpointStore,
  slug: string,
  cursor: { reducerVersion: string; reducedThroughOffset: number },
  state: State,
  stateChanged: boolean,
): void {
  store.put(reduceCursorKey(slug), {
    reducerVersion: cursor.reducerVersion,
    reducedThroughOffset: cursor.reducedThroughOffset,
  });
  if (stateChanged) store.put(reduceStateKey(slug), state);
}
