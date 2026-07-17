// `iterate/live-state` — the live-state wire codec: the snapshot+patch
// protocol, the structural diff that produces patches, and the client store
// that reassembles them. Shared by the SERVER engine (apps/os produces
// updates with `diff`) and every client (`useLiveState` folds them via the
// store). Pure data — no socket, no keeper — so a Worker can import it
// without dragging the browser session machinery into its bundle.
export { createLiveStateStore } from "./itx/live-state/store.ts";
export { applyPatch, diff } from "./itx/live-state/diff.ts";
export type { LiveStatePatch, LiveUpdate } from "./itx/live-state/protocol.ts";
