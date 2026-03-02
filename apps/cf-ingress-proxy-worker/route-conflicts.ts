import { selectPatternConflicts, selectPatternConflictsExcludingRoute } from "./sql/queries.ts";

export class RouteInputError extends Error {}

const PATTERN_CHARS = /^[a-z0-9*._-]+$/;

export type PatternConflict = {
  routeId: string;
  pattern: string;
};

export function normalizePattern(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) throw new RouteInputError("pattern is required");
  if (trimmed.includes("..")) {
    throw new RouteInputError(`Invalid pattern: ${input}`);
  }

  const normalized = trimmed.replace(/\.$/, "");
  if (!normalized) {
    throw new RouteInputError(`Invalid pattern: ${input}`);
  }
  if (!PATTERN_CHARS.test(normalized)) {
    throw new RouteInputError(`Invalid pattern: ${input}`);
  }
  const wildcardCount = (normalized.match(/\*/g) ?? []).length;
  const wildcardTail = normalized.slice(1);
  if (
    wildcardCount > 0 &&
    (wildcardCount !== 1 ||
      !normalized.startsWith("*") ||
      normalized.length <= 1 ||
      /^[a-z0-9]$/.test(normalized[1] ?? "") ||
      !wildcardTail.includes(".") ||
      !/[a-z0-9]/.test(wildcardTail))
  ) {
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
  patternsAreNormalized?: boolean;
}): Promise<PatternConflict[]> {
  const { db, excludeRouteId, patternsAreNormalized } = params;
  const normalizedPatterns = [
    ...new Set(patternsAreNormalized ? params.patterns : params.patterns.map(normalizePattern)),
  ];
  if (normalizedPatterns.length === 0) return [];

  if (excludeRouteId) {
    const rows = await selectPatternConflictsExcludingRoute(db, {
      patterns: normalizedPatterns,
      excludeRouteId: normalizeRouteId(excludeRouteId),
    });
    return rows;
  }

  const rows = await selectPatternConflicts(db, {
    patterns: normalizedPatterns,
  });
  return rows;
}
