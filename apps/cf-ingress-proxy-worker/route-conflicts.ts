export class RouteInputError extends Error {}

const PATTERN_CHARS = /^[a-z0-9*._-]+$/;

export type PatternConflict = {
  routeId: string;
  pattern: string;
};

export function normalizePattern(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) throw new RouteInputError("pattern is required");
  if (!PATTERN_CHARS.test(normalized)) {
    throw new RouteInputError(`Invalid pattern: ${input}`);
  }
  if (normalized.includes("..")) {
    throw new RouteInputError(`Invalid pattern: ${input}`);
  }
  return normalized;
}

export function normalizeRouteId(input: string): string {
  const routeId = input.trim();
  if (!routeId) throw new RouteInputError("routeId is required");
  return routeId;
}

export async function findPatternConflicts(params: {
  db: D1Database;
  patterns: string[];
  excludeRouteId?: string;
}): Promise<PatternConflict[]> {
  const { db, excludeRouteId } = params;
  const normalizedPatterns = [...new Set(params.patterns.map(normalizePattern))];
  if (normalizedPatterns.length === 0) return [];

  const bindValues: string[] = [...normalizedPatterns];
  const patternPlaceholders = normalizedPatterns.map((_, i) => `?${i + 1}`).join(", ");

  let sql = `
    SELECT route_id AS routeId, pattern
    FROM route_patterns
    WHERE pattern IN (${patternPlaceholders})
  `;

  if (excludeRouteId) {
    bindValues.push(normalizeRouteId(excludeRouteId));
    sql += ` AND route_id != ?${bindValues.length}`;
  }

  sql += " ORDER BY route_id ASC, pattern ASC";

  const rows = await db
    .prepare(sql)
    .bind(...bindValues)
    .all<PatternConflict>();
  return rows.results ?? [];
}
