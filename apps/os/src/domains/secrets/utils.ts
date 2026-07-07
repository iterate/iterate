import { normalizePath } from "../durable-object-names.ts";

/**
 * The egress placeholder grammar. A request header may carry
 * `getSecret({ path: "/secrets/…" })` (substitute the whole material — which
 * must then be a string) or `getSecret({ path: "/secrets/…", field: "a.b" })`
 * (substitute one dotted field of structured material). Substitution is
 * header-only, everywhere, forever: a header is a substitutable reference, a
 * body is bytes the composer already holds (see
 * apps/os/docs/integrations-and-secrets-design.md §2.1 and ADR 0005). The
 * `field` key is optional; omit it for whole-material (plain-string) secrets.
 */
const SECRET_REFERENCE =
  /getSecret\(\s*\{\s*path\s*:\s*"([^"]+)"\s*(?:,\s*field\s*:\s*"([^"]+)"\s*)?\}\s*\)/g;

/** One parsed placeholder: the secret it addresses and, optionally, the dotted
 * field of that secret's material to substitute. */
type SecretReference = { field?: string; path: string };

/**
 * The platform-credential placeholder: `getSecret({ platform: "<configPath>" })`
 * references a deployment-owned API key by its literal AppConfig path (e.g.
 * `integrations.parallel.apiKey`). Resolved by the project egress door from
 * typed config against a known allowlist (platform-secrets.ts) — never a
 * Durable Object, never project material.
 */
const PLATFORM_REFERENCE = /getSecret\(\s*\{\s*platform\s*:\s*"([^"]+)"\s*\}\s*\)/g;

/** One parsed platform placeholder: the AppConfig path it references. */
type PlatformReference = { platform: string };

export function normalizeSecretPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/secrets/")) {
    throw new Error(`secret path must start with "/secrets/", got "${normalized}"`);
  }
  return normalized;
}

/** Every distinct placeholder across all headers. All must address the same
 * secret — the Secret DO rejects foreign paths (one request, one secret). */
export function secretReferencesFromHeaders(headers: Headers): SecretReference[] {
  const byKey = new Map<string, SecretReference>();
  headers.forEach((value) => {
    for (const match of value.matchAll(SECRET_REFERENCE)) {
      const path = normalizeSecretPath(match[1]!);
      const field = match[2];
      byKey.set(`${path} ${field ?? ""}`, field === undefined ? { path } : { field, path });
    }
  });
  return [...byKey.values()];
}

/** The distinct secret PATHS referenced across all headers — used by the
 * project egress door to pick which Secret DO to hand the request to (exactly
 * one; multi-secret requests are not supported) and as a cheap presence check. */
export function secretReferencePathsFromHeaders(headers: Headers): string[] {
  return [...new Set(secretReferencesFromHeaders(headers).map((reference) => reference.path))];
}

/** Every distinct platform-credential placeholder across all headers. */
export function platformReferencesFromHeaders(headers: Headers): PlatformReference[] {
  const byPath = new Map<string, PlatformReference>();
  headers.forEach((value) => {
    for (const match of value.matchAll(PLATFORM_REFERENCE)) {
      byPath.set(match[1]!, { platform: match[1]! });
    }
  });
  return [...byPath.values()];
}

/** Rewrites every `getSecret({ platform: ... })` placeholder in every header
 * using `resolve`. Runs in trusted platform code (the project egress door). */
export function substitutePlatformHeaders(
  request: Request,
  resolve: (reference: PlatformReference) => string,
): Request {
  const headers = new Headers(request.headers);
  headers.forEach((value, name) => {
    headers.set(
      name,
      value.replaceAll(PLATFORM_REFERENCE, (_match, platform: string) => resolve({ platform })),
    );
  });
  return new Request(request, { headers });
}

/**
 * Selects the string a placeholder resolves to from decrypted material. No
 * field means the whole material, which must therefore be a string (the
 * plain-secret case: an API key). A field walks a dotted path into structured
 * material and must land on a string — you cannot substitute an object into a
 * header.
 */
export function selectSecretField(material: unknown, field?: string): string {
  if (field === undefined) {
    if (typeof material !== "string") {
      throw new SecretSubstitutionError("secret_material_not_a_string");
    }
    return material;
  }
  let value: unknown = material;
  for (const segment of field.split(".")) {
    if (typeof value !== "object" || value === null || !(segment in value)) {
      throw new SecretSubstitutionError("secret_reference_field_not_found");
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value !== "string") {
    throw new SecretSubstitutionError("secret_material_not_a_string");
  }
  return value;
}

/**
 * Rewrites every `getSecret(...)` placeholder in every header using `resolve`.
 * The resolver is handed the parsed reference and returns the substituted
 * string; it runs in the Secret DO (trusted platform code), so material bytes
 * are only ever handled here on the way out to a pinned host.
 */
export function substituteSecretHeaders(
  request: Request,
  resolve: (reference: SecretReference) => string,
): Request {
  const headers = new Headers(request.headers);
  headers.forEach((value, name) => {
    headers.set(
      name,
      value.replaceAll(SECRET_REFERENCE, (_match, path: string, field: string | undefined) =>
        resolve(
          field === undefined
            ? { path: normalizeSecretPath(path) }
            : { field, path: normalizeSecretPath(path) },
        ),
      ),
    );
  });
  return new Request(request, { headers });
}

/** Hex-encoded keyed HMAC-SHA256 over caller bytes — the webhook-signature
 * primitive (GitHub `sha256=`, Slack `v0=`). Pure (no state) so it unit-tests
 * without workerd; WebCrypto is present in every isolate, so no helper library. */
export async function computeHmacHex(input: {
  key: string;
  payload: string | Uint8Array;
}): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const payload =
    typeof input.payload === "string" ? new TextEncoder().encode(input.payload) : input.payload;
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, payload as BufferSource);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * RSASSA-PKCS1-v1_5 / SHA-256 signature (RS256) over caller bytes, returned
 * base64url — the JWT-signing primitive for the Secret DO's GitHub App
 * installation-token mint. The key is imported here from PKCS#8 PEM and never
 * returned. Pure + WebCrypto, so no helper library and unit-testable without
 * workerd.
 */
export async function computeSignatureBase64Url(input: {
  privateKeyPem: string;
  payload: string | Uint8Array;
}): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(input.privateKeyPem),
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
  const payload =
    typeof input.payload === "string" ? new TextEncoder().encode(input.payload) : input.payload;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    payload as BufferSource,
  );
  return base64UrlFromBytes(new Uint8Array(signature));
}

/** Decode a PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") to a raw DER ArrayBuffer
 * (a concrete ArrayBuffer, as WebCrypto's importKey wants — mirrors crypto.ts). */
function pemToPkcs8(pem: string): ArrayBuffer {
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

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Length-then-constant-time comparison of two strings. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type SecretErrorCode =
  | "secret_material_not_a_string"
  | "secret_not_allowed_for_origin"
  | "secret_not_found"
  | "secret_reference_field_not_found"
  | "secret_reference_foreign"
  | "secret_reference_required";

/** A substitution failure carrying a stable code so the egress path can answer
 * a 4xx instead of leaking an exception. */
export class SecretSubstitutionError extends Error {
  constructor(readonly code: SecretErrorCode) {
    super(code);
    this.name = "SecretSubstitutionError";
  }
}

/** The one code→status mapping: a destination outside the pin is forbidden
 * (403); every other substitution failure is a bad request (400). */
export function secretErrorResponse(code: SecretErrorCode): Response {
  return Response.json(
    { error: code },
    { status: code === "secret_not_allowed_for_origin" ? 403 : 400 },
  );
}
