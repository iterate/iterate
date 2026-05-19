export function parseMetadataJson(
  value: string,
): { metadata: Record<string, unknown> } | { message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { message: "Metadata must be valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { message: "Metadata must be a JSON object." };
  }

  return { metadata: parsed as Record<string, unknown> };
}
