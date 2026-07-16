import { applyPatch } from "iterate/live-state-diff";
import type { LiveUpdate } from "iterate/live-state-protocol";

/**
 * The client half of the live-state channel: a tiny external store that folds
 * wire updates (one snapshot, then patches) back into the live value. The
 * server's `LiveState` is the producing half; `useLiveState` renders
 * this store via `useSyncExternalStore`.
 *
 * Revision discipline: a patch only applies when its `from` matches the held
 * revision. A mismatch means a message was missed (or arrived from a stale
 * subscription's revision line) — the store calls `resync` and holds its value
 * until the fresh snapshot lands, so a gap can never silently corrupt state.
 */
type LiveStateStore<State> = {
  getState: () => State | undefined;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
  /** Fold one wire update into the held value; a revision gap means a missed patch — resync. */
  apply: (update: LiveUpdate<State>, resync: () => void) => void;
};

export function createLiveStateStore<State>(): LiveStateStore<State> {
  let held: { revision: number; state: State | undefined } = { revision: -1, state: undefined };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getState: () => held.state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset: () => {
      held = { revision: -1, state: undefined };
      notify();
    },
    apply: (update: LiveUpdate<State>, resync: () => void) => {
      if (update.type === "snapshot") {
        held = { revision: update.revision, state: update.state };
      } else if (update.from !== held.revision) {
        resync();
        return;
      } else {
        held = { revision: update.to, state: applyPatch(held.state as State, update.patch) };
      }
      notify();
    },
  };
}
