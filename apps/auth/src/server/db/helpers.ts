function parseJson(value: string | null | undefined) {
  if (!value) return null;
  return JSON.parse(value) as unknown;
}

export function parseProjectMetadata(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export function parseTimestampMs(value: number | null | undefined): Date | null {
  return typeof value === "number" ? new Date(value) : null;
}

export function parseBoolean(value: number | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  return value === 1;
}
