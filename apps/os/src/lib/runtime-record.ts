// Defensive readers for runtime/debug payloads that cross the itx boundary
// untyped: a shape miss degrades to undefined/null, never a crash. Shared by
// the processors panel and its pretty-state renderers.

export function readRuntimeRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  // Runtime payloads are untyped; the guards above prove the record shape,
  // and cloning it would only add work without improving safety.
  return value as Record<string, unknown>;
}

export function readNumber(value: unknown, key: string): number | null {
  const record = readRuntimeRecord(value);
  const field = record?.[key];
  return typeof field === "number" || typeof field === "bigint" ? Number(field) : null;
}
