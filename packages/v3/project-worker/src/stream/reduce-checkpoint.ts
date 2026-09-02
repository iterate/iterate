// reduce-checkpoint.ts — THE ONE spelling of a persisted reduce checkpoint, shared by BOTH hosts:
// the stream's own core reduce (stream.ts — reduced inside every commit's transaction) and the
// facet-hosted `ProcessorEngine` (processor.ts — driven away from the commit point).
//
// TWO keys on purpose (not one blob): a tiny CURSOR (`reducerVersion` + `reducedThroughOffset`) and
// the STATE blob. The cursor is cheap to write; the state is written ONLY when the reduce actually
// changed it, so an unchanged batch never rewrites the whole state. An ABSENT state key with a
// matching cursor means the reduce never changed state = `initialState()` (a pure side-effect
// processor; reusing the cursor stops it re-firing its whole effect history on every rebuild).
//
// Both hosts write the cursor on every durable batch and the state only when it changed; the
// facet additionally never advances on an ephemeral-only range (its `sawDurable`). The cadence
// lives at the call sites, not here.

/** The durable kv a checkpoint lives in — `ctx.storage.kv` (the stream's and the facet's alike) and
 *  the unit lane's in-memory stand-in both satisfy it. */
export type CheckpointStore = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
};

/** The cursor key — read directly by the engine's constructor for a stale (other-version) checkpoint. */
export const reduceCursorKey = (slug: string): string => `reduce:${slug}:progress`;
export const reduceStateKey = (slug: string): string => `reduce:${slug}:state`;

/** Read the persisted checkpoint for `slug`, or `undefined` when there is no cursor OR the stored
 *  cursor's version doesn't match — the caller then rebuilds from offset 0 (a version re-reduce / cold
 *  catch-up). */
export function readReduceCheckpoint<State>(
  store: CheckpointStore,
  slug: string,
  version: string,
  initialState: () => State,
): { reducedThroughOffset: number; state: State } | undefined {
  const cursor = store.get<{ reducerVersion: string; reducedThroughOffset: number }>(
    reduceCursorKey(slug),
  );
  if (!cursor || cursor.reducerVersion !== version) return undefined;
  const state = store.get<State>(reduceStateKey(slug));
  return {
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
