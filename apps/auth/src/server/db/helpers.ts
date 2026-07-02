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

// The oauth-provider plugin stores client secrets AND opaque tokens as
// unsalted SHA-256 base64url (its `defaultHasher`, the default for both
// storeClientSecret: "hashed" and storeTokens: "hashed") and compares hashes
// at the token endpoint. Seeded secrets and token lookups must hash the raw
// value the same way to match the stored row.
export async function hashOAuthStoredValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
