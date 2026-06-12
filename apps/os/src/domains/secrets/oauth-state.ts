// Stateless OAuth state: an HMAC-signed, short-lived token instead of a D1
// row. The state carries everything the callback needs (project, user,
// post-auth redirect, PKCE verifier) — signed with the deployment secrets
// key, expiring in 10 minutes, consumed by signature+expiry check alone. No
// table, nothing to clean up. Node-safe (pure webcrypto) so provider logic
// can be tested directly.

import { z } from "zod";

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

export async function signOAuthState(input: {
  key: string;
  payload: Omit<OAuthStatePayload, "expiresAtMs">;
  nowMs: number;
}): Promise<string> {
  const body = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({ ...input.payload, expiresAtMs: input.nowMs + OAUTH_STATE_TTL_MS }),
    ),
  );
  return `${body}.${await hmac(input.key, body)}`;
}

export async function verifyOAuthState(input: {
  key: string;
  state: string;
  nowMs: number;
}): Promise<OAuthStatePayload | null> {
  const [body, signature] = input.state.split(".");
  if (!body || !signature) return null;
  if (!timingSafeEqual(await hmac(input.key, body), signature)) return null;
  const payload = OAuthStatePayload.safeParse(JSON.parse(base64UrlDecode(body)));
  if (!payload.success) return null;
  if (input.nowMs > payload.data.expiresAtMs) return null;
  return payload.data;
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  return atob(value.replaceAll("-", "+").replaceAll("_", "/"));
}
