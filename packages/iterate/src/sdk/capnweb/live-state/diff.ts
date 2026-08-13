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
 * maps and diffed per key. Everything else — primitives, `null`, arrays, and
 * non-plain instances like `Date`/`Map`/`Set` — is a leaf, replaced wholesale.
 * Descending into an instance would diff its own enumerable keys, which for a
 * `Date` is NONE — two different Dates would read as "unchanged" and the
 * subscriber would stay stale forever. (Model collections that need
 * fine-grained diffing as keyed objects, not arrays.)
 */
export function diff(prev: unknown, next: unknown): LiveStatePatch | undefined {
  if (Object.is(prev, next)) return undefined;
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
    // oxlint-disable-next-line iterate/simple-truthiness-check -- falsy field values (0, '', false, null) are kept; only undefined reads as removed
    if (next[key] === undefined) {
      if (Object.hasOwn(prev, key)) drop.push(key); // a key set to `undefined` reads as removed
      continue;
    }
    const childPatch = diff(Object.hasOwn(prev, key) ? prev[key] : undefined, next[key]);
    if (childPatch) fields.push([key, childPatch]);
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
  if (typeof value !== "object" || !value) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || !proto;
}
