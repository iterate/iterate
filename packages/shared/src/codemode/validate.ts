/**
 * Provider array validation: path conflicts, duplicates, reserved names.
 */

const RESERVED_PATH_SEGMENTS = new Set(["__dispatchers", "__logs", "__logger"]);

export interface PathEntry {
  path: string[];
}

export function validateProviderPaths(entries: PathEntry[]): string | null {
  const seen: string[][] = [];

  for (const entry of entries) {
    if (entry.path.length === 0) {
      return "Provider path must have at least one segment";
    }

    for (const segment of entry.path) {
      if (!segment) {
        return "Provider path segments must be non-empty strings";
      }
      if (RESERVED_PATH_SEGMENTS.has(segment)) {
        return `Provider path segment "${segment}" is reserved`;
      }
    }

    const pathKey = entry.path.join(".");

    for (const existing of seen) {
      const existingKey = existing.join(".");
      if (pathKey === existingKey) {
        return `Duplicate provider path: [${entry.path.map((s) => `"${s}"`).join(", ")}]`;
      }
      if (pathKey.startsWith(existingKey + ".") || existingKey.startsWith(pathKey + ".")) {
        return `Provider path [${entry.path.map((s) => `"${s}"`).join(", ")}] conflicts with [${existing.map((s) => `"${s}"`).join(", ")}]: a path cannot be both a provider and a namespace`;
      }
    }

    seen.push(entry.path);
  }

  return null;
}
