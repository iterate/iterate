export class RouteInputError extends Error {}

const PATTERN_CHARS = /^[a-z0-9*._-]+$/;
export const MAX_PATTERN_LENGTH = 253;

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
  if (normalized.length > MAX_PATTERN_LENGTH) {
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

export function normalizeExternalId(input: string): string {
  const externalId = input.trim();
  if (!externalId) throw new RouteInputError("externalId is required");
  return externalId;
}
