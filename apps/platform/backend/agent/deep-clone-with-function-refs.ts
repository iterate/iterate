// deep-clone-with-function-refs.ts
// Utility function to deep-clone arbitrary JSON-serialisable values **without** losing
// function references.  We cannot rely on `JSON.parse(JSON.stringify())` or on the
// `structuredClone()` browser API because both strip out / refuse to clone functions.
// This helper performs a manual deep-clone where primitives, Dates, RegExps and
// arrays are cloned, plain objects are cloned deeply, and **functions are copied by
// reference** so that they continue to work in the cloned value.
//
// NOTE: This helper is intentionally *simple*.  It is designed for cloning our
// agent state objects which are plain JSON-y data with the occasional function
// (e.g. runtime tool `execute` methods).  If you need exotic cloning semantics
// (Map, Set, class instances, etc.) extend it consciously – do **not** add magic.

export const deepCloneWithFunctionRefs = <T>(obj: T): T => {
  // Primitives (string, number, boolean, null, undefined, symbol, bigint) – return as-is
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // Functions – preserve reference
  if (typeof obj === "function") {
    return obj;
  }

  // Date – clone by value
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as unknown as T;
  }

  // RegExp – clone by pattern & flags
  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags) as unknown as T;
  }

  // Array – deep-clone each element
  if (Array.isArray(obj)) {
    return (obj as unknown as Array<unknown>).map((item) =>
      deepCloneWithFunctionRefs(item),
    ) as unknown as T;
  }

  // Plain object – clone every own enumerable property
  const cloned: Record<string | symbol, unknown> = {};
  for (const key in obj as Record<string | symbol, unknown>) {
    if (Object.hasOwn(obj as Record<string | symbol, unknown>, key)) {
      cloned[key] = deepCloneWithFunctionRefs((obj as Record<string | symbol, unknown>)[key]);
    }
  }
  return cloned as T;
};
