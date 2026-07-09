import type { LiveStatePatch } from "./protocol.ts";

/**
 * Structural diff between two JSON values, producing the minimal `LiveStatePatch`
 * — or `undefined` when nothing changed.
 *
 * The diff is REFERENCE-FIRST: identical references short-circuit immediately
 * (`Object.is`), so the cost is O(changed), not O(size) — *as long as callers
 * update state immutably* (unchanged sub-objects keep their identity). That one
 * discipline is the whole performance story: a single touched row in a
 * thousand-entry index yields one tiny patch instead of a full rescan.
 *
 * Plain objects are treated as keyed maps and diffed per key. Everything else —
 * primitives, `null`, and arrays — is a leaf, replaced wholesale. (Model
 * collections that need fine-grained diffing as keyed objects, not arrays.)
 */
export function diff(prev: unknown, next: unknown): LiveStatePatch | undefined {
  if (Object.is(prev, next)) return undefined;
  if (!isPlainObject(prev) || !isPlainObject(next)) return { set: next };

  const fields: Record<string, LiveStatePatch> = {};
  const drop: string[] = [];
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) {
      if (key in prev) drop.push(key); // a key set to `undefined` reads as removed
      continue;
    }
    const childPatch = diff(prev[key], next[key]);
    if (childPatch !== undefined) fields[key] = childPatch;
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) drop.push(key);
  }

  const hasFields = Object.keys(fields).length > 0;
  if (!hasFields && drop.length === 0) return undefined;
  const patch: { fields?: Record<string, LiveStatePatch>; drop?: string[] } = {};
  if (hasFields) patch.fields = fields;
  if (drop.length > 0) patch.drop = drop;
  return patch;
}

/**
 * Apply a `LiveStatePatch` to a previous value, returning the next value.
 *
 * Like `diff`, this preserves structural sharing: a fresh object is built only
 * along changed paths, so untouched branches keep their previous reference.
 * That's what lets a client selector (`s => s.streamsIndex`) skip re-rendering
 * when an unrelated slice changed — the slice it reads stays `Object.is`-equal
 * across applies.
 */
export function applyPatch<State>(prev: State, patch: LiveStatePatch): State {
  if ("set" in patch) return patch.set as State;
  const base: Record<string, unknown> = isPlainObject(prev) ? prev : {};
  const next: Record<string, unknown> = { ...base };
  if (patch.fields) {
    for (const [key, childPatch] of Object.entries(patch.fields)) {
      next[key] = applyPatch(base[key], childPatch);
    }
  }
  if (patch.drop) {
    for (const key of patch.drop) delete next[key];
  }
  return next as State;
}

/** A JSON object (not an array, not `null`) — the only thing `diff` descends into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
