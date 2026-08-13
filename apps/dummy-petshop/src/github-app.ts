/**
 * GitHub-App JWT verification for the pet shop — the third-party half of the
 * first-party GitHub proof (apps/os/docs/integrations-and-secrets-design.md §9
 * P4, ADR 0006). GitHub mints an installation token when a client presents a
 * short-lived JSON Web Token signed by the App's RSA private key; the App
 * registry (state.ts) holds ONLY the matching PUBLIC key, so this module can do
 * one thing and one thing only: VERIFY a presented App JWT. It never signs —
 * signing happens on the OS side inside a jailed worker via the secrets `sign()`
 * compute method (utils.ts `computeSignatureBase64Url`), and the App private key
 * never leaves its secret. That asymmetry is the whole point being proven.
 *
 * The JWT is the compact-serialization shape `sign()` produces: three base64url
 * segments `header.payload.signature`, where the RS256 signature is computed
 * over the ASCII bytes of `header.payload` (the first two segments joined by a
 * dot). Verification therefore re-uses the EXACT signing input by splitting the
 * token — never by re-encoding — so there is no possible header/payload
 * canonicalisation mismatch with the signer.
 *
 * Pure functions of (jwt, publicKeyPem, …): no state, no DO, just WebCrypto,
 * so the whole thing unit-tests in plain Node (see github-app.test.ts).
 */

/** The only JWT algorithm petshop's App registry verifies (design §9 P4;
 * `sign()` is RS256 today, ES256 later). */
export const APP_JWT_ALG = "RS256";

/**
 * The outcome of verifying a presented App JWT: either it is good, or it is
 * rejected with a stable machine reason (surfaced as the 401's
 * `error_description` so a failing OS-side proof can see WHY). Every rejection
 * path collapses to a 401 at the endpoint — the reason is diagnostic only.
 */
export type AppJwtVerification =
  | { ok: true; iss: string; exp: number }
  | { ok: false; reason: string };

/** base64url (no padding) → bytes, mirroring seal.ts `fromB64url`. */
function bytesFromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Decode one base64url JWT segment to the JSON value it encodes, or null if it
 * is not valid base64url-encoded JSON (a malformed token, not a crash). */
function jsonFromBase64UrlSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytesFromBase64Url(segment)));
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Decode an SPKI (`-----BEGIN PUBLIC KEY-----`) PEM to a DER ArrayBuffer — the
 * concrete ArrayBuffer WebCrypto's importKey wants (mirrors os' `pemToPkcs8`). */
function pemToSpkiDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/**
 * Verify a GitHub-App JWT against a registered app's public key. Checks, in
 * order: the token has three segments; the header names `alg: RS256`; the RS256
 * signature verifies over `header.payload` under the SPKI public key; the `iss`
 * claim equals the expected app id; and `exp` is a future unix-seconds instant.
 * Any failure returns `{ ok: false, reason }` (never throws — a malformed PEM or
 * garbage token is a rejection, not a crash). The signature is checked BEFORE
 * the claims are trusted, exactly like a real verifier.
 */
export async function verifyAppJwt(input: {
  jwt: string;
  publicKeyPem: string;
  expectedAppId: string;
  now: number;
}): Promise<AppJwtVerification> {
  const segments = input.jwt.split(".");
  if (segments.length !== 3) return { ok: false, reason: "malformed_jwt" };
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const header = jsonFromBase64UrlSegment(headerSegment);
  if (!header || header.alg !== APP_JWT_ALG) return { ok: false, reason: "unsupported_alg" };

  let signatureValid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToSpkiDer(input.publicKeyPem),
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      // `as BufferSource`: WebCrypto's ArrayBuffer-backed BufferSource, exactly
      // as os' utils.test.ts casts the sibling verify (ArrayBufferLike mismatch).
      bytesFromBase64Url(signatureSegment) as BufferSource,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`) as BufferSource,
    );
  } catch {
    // A malformed public key or signature segment is a rejection, not a 500.
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: "bad_signature" };

  const payload = jsonFromBase64UrlSegment(payloadSegment);
  if (!payload) return { ok: false, reason: "malformed_payload" };
  if (payload.iss !== input.expectedAppId) return { ok: false, reason: "issuer_mismatch" };
  if (typeof payload.exp !== "number" || payload.exp <= input.now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, iss: payload.iss, exp: payload.exp };
}
