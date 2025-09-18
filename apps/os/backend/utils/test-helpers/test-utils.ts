/**
 * Extracts specified fields from an array of objects using JSON path notation.
 * Useful for creating concise test assertions with inline snapshots.
 *
 * @example
 * const events = [
 *   { type: "message", data: { content: "hello" } },
 *   { type: "error", data: { content: "oops" } }
 * ];
 *
 * pluckFields(events, ["type", "data.content"])
 * // Returns: '["message","hello"]\n["error","oops"]' (defaults: both flags true)
 *
 * pluckFields(events, ["type", "data.content"], { joinRows: false, stringifyColumns: false })
 * // Returns: [["message", "hello"], ["error", "oops"]]
 *
 * pluckFields(events, ["type", "data.content"], { joinRows: false })
 * // Returns: ['["message","hello"]', '["error","oops"]']
 *
 * @param objects - Array of objects to extract fields from
 * @param paths - Array of JSON paths (e.g., "data.content" for nested fields)
 * @param ops - Optional operation flags (both default to true)
 * @param ops.joinRows - If true, join all rows with newlines into a single string (default: true)
 * @param ops.stringifyColumns - If true, JSON.stringify each row (inner array) (default: true)
 * @returns String with extracted values by default, or array based on ops
 */
export function pluckFields<T extends Record<string, any>>(
  objects: readonly T[],
  paths: string[],
  ops?: { joinRows?: boolean; stringifyColumns?: boolean },
): string | string[] | unknown[][] {
  // Default both options to true
  const { joinRows = true, stringifyColumns = true } = ops || {};

  const rows = objects.map((obj) =>
    paths.map((path) => {
      const segments = path.split(".");
      let value: any = obj;

      for (const segment of segments) {
        value = value?.[segment];
      }

      return value;
    }),
  );

  // Apply operations based on flags
  if (stringifyColumns && joinRows) {
    // Both flags: stringify each row then join with newlines
    return rows.map((row) => JSON.stringify(row)).join("\n");
  } else if (stringifyColumns) {
    // Only stringify: return array of stringified rows
    return rows.map((row) => JSON.stringify(row));
  } else if (joinRows) {
    // Only join: join array representations with newlines
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }

  // Neither flag: return array of arrays
  return rows;
}
