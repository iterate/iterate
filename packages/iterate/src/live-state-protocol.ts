/**
 * Wire types for the live-state channel: what a server LiveState pushes down a
 * subscription. A subscription always delivers one `snapshot` first (the full
 * current state), then a stream of `patch`es — each the minimal structural diff
 * since the previous revision. `useLiveState` reassembles these into the live
 * value, so feature code never touches these types directly.
 *
 * See `diff.ts` for how patches are produced (`diff`) and applied (`applyPatch`).
 */

/**
 * A structural patch turning a previous JSON value into the next one. Two
 * shapes, discriminated by whether the `set` key is present:
 * - `{ set }` — replace this position wholesale. Used for primitives, arrays
 *   (treated as opaque leaves, never diffed positionally), `null`, type changes,
 *   and newly-added object keys.
 * - `{ fields?, drop? }` — descend into a plain object: `fields` maps each
 *   changed key to its own patch; `drop` lists keys that disappeared. At least
 *   one is present (an empty descend never gets emitted).
 */
export type LiveStatePatch =
  | { set: unknown }
  | { fields?: Record<string, LiveStatePatch>; drop?: string[] };

/**
 * One message pushed down a live-state subscription. The first is always a
 * `snapshot` (a resync sends a fresh one); every message after carries only the
 * diff from revision `from` to `to`. Revisions are monotonic for the life of one
 * subscription, so a gap (`from` ≠ the client's revision) means a message was
 * missed and the client should resubscribe.
 *
 * `State` is asserted by the caller of `useLiveState` — the wire itself is
 * structure-agnostic.
 */
export type LiveUpdate<State = unknown> =
  | { type: "snapshot"; revision: number; state: State }
  | { type: "patch"; from: number; to: number; patch: LiveStatePatch };
