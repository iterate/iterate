import { z } from "zod/v4";
import { JSONSerializable } from "./type-helpers.ts";

export const passThroughArgsSchema = z
  .record(z.string(), JSONSerializable)
  .nullable()
  .default(null);
/**
 * Merges pass-through arguments with a payload according to specific rules.
 *
 * This function is used to combine additional arguments that need to be passed through
 * with the main payload when executing callbacks (e.g., DURABLE_OBJECT_PROCEDURE or TRPC_PROCEDURE).
 *
 * Merging rules:
 * 1. If passThroughArgs is undefined or null, returns the payload as-is
 * 2. If both passThroughArgs and payload are objects, spreads passThroughArgs over payload
 * 3. If both are arrays, merges them element by element (passThroughArgs overwrites payload elements)
 * 4. Throws an error for any other combination
 *
 * @param passThroughArgs - Additional arguments to merge with the payload
 * @param payload - The main payload to merge with
 * @returns The merged result
 * @throws Error if the types cannot be merged according to the rules
 *
 * @example
 * // Object merging
 * mergePassThroughArgs({ foo: "bar" }, { baz: "qux" })
 * // => { baz: "qux", foo: "bar" }
 *
 * // Array merging
 * mergePassThroughArgs([1, 2], [3, 4, 5])
 * // => [1, 2, 5]
 *
 * // Null/undefined passthrough
 * mergePassThroughArgs(null, { foo: "bar" })
 * // => { foo: "bar" }
 */
export function mergePassThroughArgs(
  passThroughArgs: JSONSerializable | null | undefined,
  payload: JSONSerializable,
): JSONSerializable {
  // Rule 1: If passThroughArgs is undefined or null, return payload as-is
  if (passThroughArgs === undefined || passThroughArgs === null) {
    return payload;
  }

  // Rule 2: If both are objects (but not arrays), merge them
  if (
    typeof passThroughArgs === "object" &&
    !Array.isArray(passThroughArgs) &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload !== null
  ) {
    // Spread payload first, then passThroughArgs to allow overrides
    return { ...payload, ...passThroughArgs };
  }

  // Rule 3: If both are arrays, merge element by element
  if (Array.isArray(passThroughArgs) && Array.isArray(payload)) {
    // Create a new array with the maximum length of both arrays
    const maxLength = Math.max(passThroughArgs.length, payload.length);
    const result: JSONSerializable[] = [];

    for (let i = 0; i < maxLength; i++) {
      if (i < passThroughArgs.length) {
        // Use passThroughArgs element if it exists
        result[i] = passThroughArgs[i];
      } else {
        // Otherwise use payload element
        result[i] = payload[i];
      }
    }

    return result;
  }

  // If we get here, the types are incompatible
  const passThroughType = Array.isArray(passThroughArgs)
    ? "array"
    : passThroughArgs === null
      ? "null"
      : typeof passThroughArgs;

  const payloadType = Array.isArray(payload) ? "array" : payload === null ? "null" : typeof payload;

  throw new Error(
    `Cannot merge passThroughArgs of type "${passThroughType}" with payload of type "${payloadType}". ` +
      `Merging is only supported when: ` +
      `1) passThroughArgs is null/undefined, ` +
      `2) both are objects (non-array), or ` +
      `3) both are arrays.`,
  );
}
