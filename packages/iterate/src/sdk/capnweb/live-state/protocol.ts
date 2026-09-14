/**
 * Wire types for the live-state channel: what a server engine pushes down a
 * subscription. A subscription always delivers one `snapshot` first (the full
 * current state), then a stream of `patch`es — each the minimal structural diff
 * since the previous revision. `useLiveState` reassembles these into the live
 * value, so feature code never touches these types directly.
 *
 * See `diff.ts` for how patches are produced (`diff`) and applied (`applyPatch`).
 */

/**
 * A structural patch turning a previous JSON value into the next one. Three
 * shapes, discriminated by `set`, `array`, or an object patch:
 * - `{ set }` — replace this position wholesale. Used for primitives,
 *   `null`, type changes,
 *   and newly-added object keys.
 * - `{ fields?, drop? }` — descend into a plain object: `fields` maps each
 *   changed key to its own patch; `drop` lists keys that disappeared. At least
 *   one is present (an empty descend never gets emitted).
 * - `{ array }` — patch changed positions and set the resulting length. Kept
 *   elements retain their identity, including immutable text blocks inside a
 *   changed step. This form is sent only to subscribers requesting version 2.
 */
export type LiveStatePatch =
  | { set: unknown }
  | { array: { length: number; items: [number, LiveStatePatch][] } }
  | { fields?: Record<string, LiveStatePatch>; drop?: string[] };

/** Explicit codec negotiation keeps already-open clients valid across deploys. */
export type LiveStateSubscriptionOptions = { patchVersion?: 2 | 3 };

/**
 * Version 3 addresses existing object fields by their sorted baseline position;
 * new fields use `+name`. Arrays use indices and an optional `#` length.
 * Primitives replace directly, `[value]` replaces other values, `[length, text]`
 * appends to a string, and `[]` deletes an object field. No dictionary survives
 * an update: every address refers to the acknowledged baseline of that patch.
 */
export type CompactLiveStatePatch =
  | string
  | number
  | boolean
  | null
  | []
  | [unknown]
  | [number, string]
  | { [address: string]: CompactLiveStatePatch };

/** A transient reader's position; a new engine incarnation always has a new epoch. */
export type LiveStateCursor = { epoch: string; revision: number };

/** A pull transports one delta, a fresh snapshot, or no change. No callback is retained. */
export type LiveStateRead<State> = { epoch: string; update: LiveUpdate<State> | null };

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
  | { type: "patch"; from: number; to: number; patch: LiveStatePatch }
  | { s: [revision: number, state: State] }
  | { p: [from: number, to: number, patch: CompactLiveStatePatch] };

export function isLiveStateSnapshot<State>(
  update: LiveUpdate<State>,
): update is Extract<LiveUpdate<State>, { type: "snapshot" } | { s: unknown }> {
  return "s" in update || ("type" in update && update.type === "snapshot");
}

export function liveStateRevision(update: LiveUpdate): number {
  if ("s" in update) return update.s[0];
  if ("p" in update) return update.p[1];
  return update.type === "snapshot" ? update.revision : update.to;
}
