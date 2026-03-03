export type ParsedForwardedHeader = {
  for?: string;
  host?: string;
  proto?: string;
};

function stripOptionalQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeProto(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/:$/, "");
  if (!normalized) return undefined;
  return normalized;
}

function needsQuotedValue(value: string): boolean {
  return /[\s,;"]/u.test(value);
}

function encodeForwardedValue(value: string): string {
  if (!needsQuotedValue(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildForwardedHeader(input: {
  for?: string | null;
  host?: string | null;
  proto?: string | null;
}): string | null {
  const parts: string[] = [];
  const forValue = input.for?.trim();
  const hostValue = input.host?.trim();
  const protoValue = normalizeProto(input.proto ?? undefined);

  if (forValue) parts.push(`for=${encodeForwardedValue(forValue)}`);
  if (hostValue) parts.push(`host=${encodeForwardedValue(hostValue)}`);
  if (protoValue) parts.push(`proto=${encodeForwardedValue(protoValue)}`);

  if (parts.length === 0) return null;
  return parts.join("; ");
}

export function parseForwardedHeader(value: string): ParsedForwardedHeader {
  const firstEntry = value.split(",")[0]?.trim() ?? "";
  if (!firstEntry) return {};

  const parsed: ParsedForwardedHeader = {};

  for (const rawPair of firstEntry.split(";")) {
    const separator = rawPair.indexOf("=");
    if (separator < 0) continue;

    const key = rawPair.slice(0, separator).trim().toLowerCase();
    const rawValue = rawPair.slice(separator + 1).trim();
    const decodedValue = stripOptionalQuotes(rawValue);
    if (!key || !decodedValue) continue;

    if (key === "for") parsed.for = decodedValue;
    if (key === "host") parsed.host = decodedValue;
    if (key === "proto") parsed.proto = normalizeProto(decodedValue);
  }

  return parsed;
}
