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
 * PLAIN objects (prototype `Object.prototype` or `null`) are treated as keyed
 * maps and diffed per key. Dense arrays are diffed by position. Everything
 * else — primitives, `null`, sparse arrays, and
 * non-plain instances like `Date`/`Map`/`Set` — is a leaf, replaced wholesale.
 * Descending into an instance would diff its own enumerable keys, which for a
 * `Date` is NONE — two different Dates would read as "unchanged" and the
 * subscriber would stay stale forever. Keyed objects remain preferable for
 * collections whose entries frequently move; positional patches do not infer moves.
 */
export function diff(
  prev: unknown,
  next: unknown,
  options: { arrays?: boolean } = {},
): LiveStatePatch | undefined {
  if (Object.is(prev, next)) return undefined;
  if (Array.isArray(prev) && Array.isArray(next) && options.arrays !== false) {
    const items: [number, LiveStatePatch][] = [];
    for (let index = 0; index < next.length; index++) {
      // Sparse arrays retain the replacement semantics of their wire value.
      if (!Object.hasOwn(next, index) || (index < prev.length && !Object.hasOwn(prev, index))) {
        return { set: next };
      }
      const patch =
        index < prev.length ? diff(prev[index], next[index], options) : { set: next[index] };
      if (patch) items.push([index, patch]);
    }
    return items.length > 0 || prev.length !== next.length
      ? { array: { length: next.length, items } }
      : undefined;
  }
  if (!isPlainObject(prev) || !isPlainObject(next)) return { set: next };

  // Entries + fromEntries, not `bag[key] = …`: assignment with key "__proto__"
  // would SET THE BAG'S PROTOTYPE instead of recording the field — the change
  // would silently vanish from the patch. `Object.fromEntries` DEFINES own
  // properties (safe for any key) and yields an ordinary Object.prototype
  // object — which matters, because patches cross capnweb, whose serializer
  // accepts exactly Object.prototype (a null-proto bag reads as unsupported
  // and kills the push). (applyPatch has the mirror-image write guard.)
  // Own-property checks throughout (`Object.hasOwn`, not `in` / bare reads):
  // `"__proto__" in x` is true for EVERY object via inheritance, so `in` would
  // misread that key's presence in both directions.
  const fields: [string, LiveStatePatch][] = [];
  const drop: string[] = [];
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) {
      if (Object.hasOwn(prev, key)) drop.push(key); // a key set to `undefined` reads as removed
      continue;
    }
    const childPatch = diff(Object.hasOwn(prev, key) ? prev[key] : undefined, next[key], options);
    if (childPatch !== undefined) fields.push([key, childPatch]);
  }
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key)) drop.push(key);
  }

  if (fields.length === 0 && drop.length === 0) return undefined;
  const patch: { fields?: Record<string, LiveStatePatch>; drop?: string[] } = {};
  if (fields.length > 0) patch.fields = Object.fromEntries(fields);
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
  if ("array" in patch) {
    if (!Array.isArray(prev)) throw new Error("Live-state array patch requires an array baseline");
    const next = prev.slice(0, patch.array.length);
    next.length = patch.array.length;
    for (const [index, child] of patch.array.items) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= next.length) {
        throw new Error("Live-state array patch index is outside its resulting length");
      }
      next[index] = applyPatch(prev[index], child);
    }
    // The array operation preserves State's shape; only the generic parameter
    // prevents TypeScript from expressing the Array.isArray narrowing on return.
    return next as State;
  }
  const base: Record<string, unknown> = isPlainObject(prev) ? prev : {};
  const next: Record<string, unknown> = { ...base };
  if (patch.fields) {
    for (const [key, childPatch] of Object.entries(patch.fields)) {
      // Define, don't assign: `next[key] =` with key "__proto__" would SET THE
      // PROTOTYPE instead of creating an own property — dropping the field and
      // letting a hostile patch inject one. (The spread above is already safe:
      // spread uses define semantics.) `Object.hasOwn` guards the read the same
      // way — a bare `base["__proto__"]` reads the prototype, not a field.
      Object.defineProperty(next, key, {
        value: applyPatch(Object.hasOwn(base, key) ? base[key] : undefined, childPatch),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  if (patch.drop) {
    for (const key of patch.drop) delete next[key];
  }
  return next as State;
}

/**
 * A PLAIN object — prototype `Object.prototype` or `null` — the only thing
 * `diff` descends into and `applyPatch` merges over. Arrays and class instances
 * (`Date`, `Map`, `Set`, …) fail this on purpose: they carry state outside
 * their own enumerable keys, so per-key diffing would misread them (see the
 * `diff` docstring) — they are leaves, replaced wholesale.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
