/**
 * Stateless token sealing: AES-256-GCM encrypted JSON blobs, cribbed from
 * the zero-trust-mcp try's dummy-oauth worker.
 *
 * Format: base64url( version(1 byte) || iv(12 bytes) || ciphertext+tag )
 *
 * GCM provides both confidentiality and integrity, so a sealed blob can be
 * handed to untrusted parties (OAuth clients, test suites) and later trusted
 * on return — no server-side token storage required. Expiry and revocation
 * handles live inside the payload; see the token payload types in worker.ts.
 */

const VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function getKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error("PETSHOP_SEAL_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedKey = { secret, key };
  return key;
}

/** Mint a fresh sealing key in the base64 format `getKey` expects. */
export function randomSealKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const padded = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function seal(payload: unknown, secret: string): Promise<string> {
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const out = new Uint8Array(1 + iv.length + ciphertext.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ciphertext, 13);
  return b64url(out);
}

/** Returns null on any failure: wrong key, tampered blob, malformed input. */
export async function unseal<T>(token: string, secret: string): Promise<T | null> {
  try {
    const bytes = fromB64url(token);
    if (bytes[0] !== VERSION || bytes.length < 14) return null;
    const key = await getKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 13) },
      key,
      bytes.slice(13),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}

/**
 * Hex HMAC-SHA256 over a string body — the webhook signature primitive.
 * Deliberately the same "HMAC over raw bytes, hex digest" shape as GitHub's
 * `x-hub-signature-256` so it matches what the secrets design verifies with
 * its `hmac()` compute method (integrations-and-secrets-design.md §2.1).
 */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)) (RFC 7636
 * §4.2). The MCP OAuth client sends `code_challenge` at /oauth/authorize and
 * the matching `code_verifier` at /oauth/token; the token endpoint recomputes
 * this and compares, so a leaked authorization code is useless without the
 * verifier that never left the client.
 */
export async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
  return b64url(digest);
}
