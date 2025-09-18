/**
 * Try to parse a value as JSON, returning the original value if parsing fails.
 */
export function tryParseJSON(value: unknown): unknown {
  try {
    return JSON.parse(value as string);
  } catch (_error) {
    return value;
  }
}

/**
 * Exhaustive match guard for TypeScript switch statements.
 * Throws an error if called, which should only happen if a case is not handled.
 */
export function ensureString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
