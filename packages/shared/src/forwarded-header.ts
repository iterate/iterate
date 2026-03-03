export type ForwardedHeaderEntry = {
  for?: string;
  host?: string;
  proto?: string;
};

export type BuildForwardedHeaderInput = {
  host: string;
  proto: "http" | "https" | "ws" | "wss";
  for?: string | null;
};

const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function splitRespectingQuotes(value: string, delimiter: ";" | ","): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (inQuotes && char === "\\") {
      current += char;
      escaping = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === delimiter) {
      const trimmed = current.trim();
      if (trimmed.length > 0) parts.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll(/\\"|\\\\/g, (matched) => matched.slice(1));
  }
  return value;
}

function sanitizeValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function parseForwardedEntry(rawEntry: string): ForwardedHeaderEntry | null {
  const params = splitRespectingQuotes(rawEntry, ";");
  const parsed: ForwardedHeaderEntry = {};

  for (const param of params) {
    const separator = param.indexOf("=");
    if (separator <= 0) continue;
    const key = param.slice(0, separator).trim().toLowerCase();
    const rawValue = param.slice(separator + 1).trim();
    const value = sanitizeValue(unquote(rawValue));
    if (!value) continue;

    if (key === "for") parsed.for = value;
    if (key === "host") parsed.host = value;
    if (key === "proto") parsed.proto = value.toLowerCase();
  }

  if (!parsed.for && !parsed.host && !parsed.proto) return null;
  return parsed;
}

function formatForwardedValue(value: string): string {
  const trimmed = value.trim();
  if (TOKEN_PATTERN.test(trimmed)) return trimmed;
  return `"${trimmed.replaceAll(/["\\]/g, "\\$&")}"`;
}

export function parseForwardedHeader(value: string | null | undefined): ForwardedHeaderEntry[] {
  if (!value) return [];
  const entries = splitRespectingQuotes(value, ",");
  return entries.flatMap((entry) => {
    const parsed = parseForwardedEntry(entry);
    return parsed ? [parsed] : [];
  });
}

export function firstForwardedEntry(
  value: string | null | undefined,
): ForwardedHeaderEntry | undefined {
  return parseForwardedHeader(value)[0];
}

export function buildForwardedHeader(input: BuildForwardedHeaderInput): string {
  const host = input.host.trim();
  if (host.length === 0) {
    throw new Error("buildForwardedHeader: host must be non-empty");
  }

  const parts: string[] = [];
  const forValue = sanitizeValue(input.for ?? undefined);
  if (forValue) {
    parts.push(`for=${formatForwardedValue(forValue)}`);
  }
  parts.push(`host=${formatForwardedValue(host)}`);
  parts.push(`proto=${formatForwardedValue(input.proto.toLowerCase())}`);
  return parts.join("; ");
}
