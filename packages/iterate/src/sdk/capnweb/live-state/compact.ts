import { isPlainObject } from "./diff.ts";
import type { CompactLiveStatePatch, LiveStatePatch } from "./protocol.ts";

const fieldAddresses = new WeakMap<object, { keys: string[]; indices: Map<string, number> }>();

function addresses(value: Record<string, unknown>) {
  let cached = fieldAddresses.get(value);
  if (!cached) {
    // Undefined object fields are absent after a JSON transport. They must not
    // shift addresses on either side of the next update.
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    cached = { keys, indices: new Map(keys.map((key, index) => [key, index])) };
    fieldAddresses.set(value, cached);
  }
  return cached;
}

/** Encode only the changed paths of an existing structural diff. */
export function compactPatch(previous: unknown, patch: LiveStatePatch): CompactLiveStatePatch {
  if ("set" in patch) {
    const next = patch.set;
    if (
      typeof previous === "string" &&
      typeof next === "string" &&
      previous.length >= 16 &&
      // Bound prefix checks even for a multi-megabyte string. Immutable text
      // blocks are ~1 KiB; larger ordinary strings retain replacement semantics.
      previous.length <= 4096 &&
      next.length > previous.length &&
      next.startsWith(previous)
    )
      return [previous.length, next.slice(previous.length)];
    if (
      next === null ||
      typeof next === "string" ||
      typeof next === "number" ||
      typeof next === "boolean"
    )
      return next;
    return [next];
  }
  if ("array" in patch) {
    if (!Array.isArray(previous))
      throw new Error("Live-state array patch requires an array baseline");
    const result: Record<string, CompactLiveStatePatch> = {};
    if (patch.array.length !== previous.length) result["#"] = patch.array.length;
    for (const [index, child] of patch.array.items)
      result[index] = compactPatch(previous[index], child);
    return result;
  }
  if (!isPlainObject(previous))
    throw new Error("Live-state object patch requires an object baseline");
  const { indices } = addresses(previous);
  const fields: [string, CompactLiveStatePatch][] = [];
  for (const [key, child] of Object.entries(patch.fields ?? {})) {
    const index = indices.get(key);
    fields.push([
      index === undefined ? `+${key}` : String(index),
      compactPatch(index === undefined ? undefined : previous[key], child),
    ]);
  }
  for (const key of patch.drop ?? []) {
    const index = indices.get(key);
    // An undefined field was already absent on the wire.
    if (index !== undefined) fields.push([String(index), []]);
  }
  return Object.fromEntries(fields);
}

/** Apply a version 3 patch, retaining every untouched object's identity. */
export function applyCompactPatch<State>(previous: State, patch: CompactLiveStatePatch): State {
  // Like applyPatch, the wire operation preserves the caller's State contract;
  // TypeScript cannot infer that contract from a recursive, generic JSON codec.
  return applyCompactValue(previous, patch) as State;
}

function applyCompactValue(previous: unknown, patch: CompactLiveStatePatch): unknown {
  if (patch === null || typeof patch !== "object") return patch;
  if (Array.isArray(patch)) {
    if (patch.length === 1) return patch[0];
    if (patch.length !== 2 || typeof previous !== "string" || previous.length !== patch[0]) {
      throw new Error("Live-state append does not match its string baseline");
    }
    return previous + patch[1];
  }
  if (Array.isArray(previous)) {
    const length = Object.hasOwn(patch, "#") ? patch["#"] : previous.length;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 0xffffffff
    ) {
      throw new Error("Live-state array patch has an invalid length");
    }
    const next = previous.slice(0, length);
    next.length = length;
    for (const [address, child] of Object.entries(patch)) {
      if (address === "#") continue;
      const index = position(address, length);
      next[index] = applyCompactValue(previous[index], child);
    }
    return next;
  }
  if (!isPlainObject(previous))
    throw new Error("Live-state object patch requires an object baseline");
  const { keys } = addresses(previous);
  const next = { ...previous };
  for (const [address, child] of Object.entries(patch)) {
    const added = address.startsWith("+");
    const key = added ? address.slice(1) : keys[position(address, keys.length)]!;
    if (added && Object.hasOwn(previous, key) && previous[key] !== undefined) {
      throw new Error("Live-state new field already exists in its baseline");
    }
    if (Array.isArray(child) && child.length === 0) {
      if (added) throw new Error("Live-state cannot delete a new field");
      delete next[key];
    } else {
      // Define own properties, including __proto__, without mutating prototypes.
      Object.defineProperty(next, key, {
        value: applyCompactValue(added ? undefined : previous[key], child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return next;
}

function position(address: string, length: number): number {
  const index = Number(address);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== address) {
    throw new Error("Live-state field address is outside its baseline");
  }
  return index;
}
