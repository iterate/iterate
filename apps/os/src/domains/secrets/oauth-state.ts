// Stateless OAuth state: a SEALED (AES-256-GCM), short-lived token instead of
// a D1 row. The state carries everything the callback needs (project, user,
// post-auth redirect, PKCE verifier) — encrypted AND authenticated with the
// deployment secrets key, expiring in 10 minutes, consumed by decrypt+expiry
// check alone. No table, nothing to clean up.
//
// Sealed rather than merely signed because the payload round-trips through
// the provider and the user's browser: a sign-only token would expose the
// PKCE code_verifier (and project/user ids) to anyone who sees the redirect.
// GCM's auth tag covers integrity, so no separate MAC.
//
// Known trade vs the old D1 row: no single-use consumption — a state token
// verifies for its whole 10-minute window. The authorization CODE is still
// single-use at the provider, and exchanges need our client secret, so
// replaying a state alone yields nothing; a real version should still add a
// replay check (jti + small KV/DO set).
//
// Node-safe (pure webcrypto) so provider logic can be tested directly.

import { z } from "zod";
import { importSecretsKey } from "~/domains/secrets/secret-crypto.ts";

export const OAuthStatePayload = z.object({
  provider: z.string(),
  projectId: z.string(),
  userId: z.string(),
  callbackUrl: z.string().optional(),
  codeVerifier: z.string().optional(),
  expiresAtMs: z.number(),
});
export type OAuthStatePayload = z.infer<typeof OAuthStatePayload>;

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Generic sealed short-lived token: AES-GCM over JSON, base64url
 * `iv.ciphertext`. OAuth state and pending-connect interstitials both ride
 * this. */
export async function sealJson(input: {
  key: string;
  payload: Record<string, unknown>;
  ttlMs: number;
  nowMs: number;
}): Promise<string> {
  const cryptoKey = await importSecretsKey(input.key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(
      JSON.stringify({ ...input.payload, expiresAtMs: input.nowMs + input.ttlMs }),
    ),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function unsealJson(input: {
  key: string;
  token: string;
  nowMs: number;
}): Promise<Record<string, unknown> | null> {
  const [iv, ciphertext] = input.token.split(".");
  if (!iv || !ciphertext) return null;
  try {
    const cryptoKey = await importSecretsKey(input.key);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(iv) as BufferSource },
      cryptoKey,
      base64UrlDecode(ciphertext) as BufferSource,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    if (typeof payload.expiresAtMs !== "number" || input.nowMs > payload.expiresAtMs) return null;
    return payload;
  } catch {
    // Tampered or wrong-key tokens fail GCM authentication.
    return null;
  }
}

export async function signOAuthState(input: {
  key: string;
  payload: Omit<OAuthStatePayload, "expiresAtMs">;
  nowMs: number;
}): Promise<string> {
  return await sealJson({
    key: input.key,
    payload: input.payload,
    ttlMs: OAUTH_STATE_TTL_MS,
    nowMs: input.nowMs,
  });
}

export async function verifyOAuthState(input: {
  key: string;
  state: string;
  nowMs: number;
}): Promise<OAuthStatePayload | null> {
  const unsealed = await unsealJson({ key: input.key, token: input.state, nowMs: input.nowMs });
  if (unsealed == null) return null;
  const payload = OAuthStatePayload.safeParse(unsealed);
  return payload.success ? payload.data : null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
