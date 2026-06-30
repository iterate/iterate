/**
 * Produces the digest format used in worker cache keys and script execution
 * event ids. Keeping this in the worker domain keeps all source identity hashes
 * on the platform-standard SHA-256 hex representation.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("stableJson cannot encode undefined");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

/**
 * Hashes structured worker source identity without depending on object key
 * insertion order. Worker Loader and repo-backed worker resolution both use it
 * so equivalent refs share cache entries even when callers build objects in a
 * different order.
 */
export async function stableSha256(value: unknown): Promise<string> {
  return await sha256Hex(stableJson(value));
}
