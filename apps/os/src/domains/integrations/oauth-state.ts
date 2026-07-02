// Stateless signed OAuth state for the integrations connect flows.
//
// The legacy stack persisted one-time oauth_states rows in D1; D1 is gone, so
// the state is now a self-contained HMAC-signed token minted itx-side
// (keyed off SECRET_ENCRYPTION_KEY) with a short expiry. "Consumption" is
// signature + expiry validation: a replayed state carries an already-used
// authorization code, which the provider rejects, so a one-time-use table
// buys nothing here.
//
// The payload is base64url JSON and deliberately parseable WITHOUT the key
// (`parseOAuthStateUnverified`) so the app-worker callback route can read the
// projectId it needs to address itx; all authority checks re-verify
// the signature itx-side.

import { z } from "zod";

const OAUTH_STATE_VERSION = "v1";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const OAuthStateData = z.object({
  callbackUrl: z.string().optional(),
  codeVerifier: z.string().optional(),
  expiresAt: z.number(),
  nonce: z.string(),
  projectId: z.string(),
  provider: z.enum(["google", "slack"]),
  userId: z.string(),
});

type OAuthStateData = z.infer<typeof OAuthStateData>;

export async function createOAuthState(
  input: Omit<OAuthStateData, "expiresAt" | "nonce">,
  keyMaterial: string,
): Promise<string> {
  const data: OAuthStateData = {
    ...input,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(data)));
  const signature = base64UrlEncode(await hmac(payload, keyMaterial));
  return `${OAUTH_STATE_VERSION}.${payload}.${signature}`;
}

/** Signature + expiry + provider validation. Returns null on any mismatch. */
export async function verifyOAuthState(
  input: { provider: "google" | "slack"; state: string },
  keyMaterial: string,
): Promise<OAuthStateData | null> {
  const [version, payload, signature] = input.state.split(".");
  if (version !== OAUTH_STATE_VERSION || !payload || !signature) return null;
  const expected = base64UrlEncode(await hmac(payload, keyMaterial));
  if (!constantTimeEqual(expected, signature)) return null;

  const data = decodeStatePayload(payload);
  if (data === null) return null;
  if (data.provider !== input.provider) return null;
  if (data.expiresAt < Date.now()) return null;
  return data;
}

/** Unverified read for routing only (projectId/provider). Never trust for authority. */
export function parseOAuthStateUnverified(state: string): OAuthStateData | null {
  const [version, payload] = state.split(".");
  if (version !== OAUTH_STATE_VERSION || !payload) return null;
  return decodeStatePayload(payload);
}

function decodeStatePayload(payload: string): OAuthStateData | null {
  try {
    const json = new TextDecoder().decode(base64UrlDecode(payload));
    return OAuthStateData.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

async function hmac(payload: string, keyMaterial: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`oauth-state:${keyMaterial}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(signature);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}
