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

/** The substituted string a referenced secret owes each requested field of a
 * chained egress request. The empty-string key `""` is the whole-material
 * placeholder (`getSecret({ path })` with no field). Shared by the Secret DO's
 * resolver and the platform-secret resolver. */
export type ResolvedFields = Record<string, string>;

export function normalizeSecretPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/secrets/")) {
    throw new Error(`secret path must start with "/secrets/", got "${normalized}"`);
  }
  return normalized;
}

/** Every distinct placeholder across all headers. One request may reference
 * several secrets (app-tier + connection-tier), which the Secret DO resolves by
 * chaining — see `SecretDurableObject.fetch`. */
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
 * project egress door to pick which Secret DO to hand the request to (any
 * referenced secret can chain the rest) and as a cheap presence check. */
export function secretReferencePathsFromHeaders(headers: Headers): string[] {
  return [...new Set(secretReferencesFromHeaders(headers).map((reference) => reference.path))];
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
 * string; it runs in the Secret DO (trusted platform code), never in a jail, so
 * material bytes are only ever handled here on the way out to a pinned host.
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

/** Hex-encoded keyed HMAC over caller bytes. Pure (no state) so it unit-tests
 * without workerd; the Secret capability's `hmac` method is this over a
 * selected field. WebCrypto is present in every isolate, so no helper library. */
export async function computeHmacHex(input: {
  algo: "sha1" | "sha256";
  key: string;
  payload: string | Uint8Array;
}): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.key),
    { hash: input.algo === "sha1" ? "SHA-1" : "SHA-256", name: "HMAC" },
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
 * base64url — the JWT-signing primitive (GitHub App JWTs, and any future
 * signing integration). Like `computeHmacHex`, it attenuates "the private key"
 * to "a signature computed under the key": the key is imported here from PKCS#8
 * PEM and never returned. Pure + WebCrypto, so no helper library and unit-
 * testable without workerd. `algo` is a param so ES256 slots in later.
 */
export async function computeSignatureBase64Url(input: {
  algo: "RS256";
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

/**
 * Sentinel URL marking a request as JAIL EGRESS on the SecretEntrypoint → Secret
 * DO hop. The Secret DO's `fetch()` does double duty — consumer traffic (which
 * may run the worker) vs the worker's own outbound (which must NOT re-run the
 * worker, just substitute + terminal fetch) — and per workerd only the `fetch`
 * method can carry a WebSocket upgrade, so the two are disambiguated **by URL
 * path**, not an RPC method or a header. The jail's outbound is wrapped to this
 * URL (real target in `?target=`) so the DO routes it to egress and can hand a
 * 101 + WebSocket back natively (an RPC method return cannot serialize a
 * WebSocket). See SecretDurableObject.fetch and secret-entrypoint.ts.
 */
const SECRET_EGRESS_SENTINEL = "https://secret-egress.iterate.internal/__egress";

/** Wrap the jailed worker's outbound request for the DO's egress lane: keep its
 * method/headers/body (incl. a WS `Upgrade`) verbatim, only re-point the URL to
 * the egress sentinel with the real target in `?target=`. */
export function wrapSecretEgressRequest(request: Request): Request {
  const wrapped = `${SECRET_EGRESS_SENTINEL}?target=${encodeURIComponent(request.url)}`;
  return new Request(wrapped, request);
}

/** The reverse of {@link wrapSecretEgressRequest}: if `request` is an egress-lane
 * request, return it re-pointed at its real target (method/headers/body copied);
 * otherwise null (it's ordinary consumer traffic). */
export function unwrapSecretEgressRequest(request: Request): Request | null {
  const url = new URL(request.url);
  if (`${url.origin}${url.pathname}` !== SECRET_EGRESS_SENTINEL) return null;
  const target = url.searchParams.get("target");
  if (target === null) return null;
  return new Request(target, request);
}

type SecretErrorCode =
  | "secret_material_not_a_string"
  | "secret_not_allowed_for_origin"
  | "secret_not_found"
  | "secret_reference_field_not_found"
  | "secret_reference_required";

/** A substitution failure carrying a stable code so the egress path can answer
 * a 4xx instead of leaking an exception. */
export class SecretSubstitutionError extends Error {
  constructor(readonly code: SecretErrorCode) {
    super(code);
    this.name = "SecretSubstitutionError";
  }
}

export function secretErrorResponse(code: SecretErrorCode, status: number): Response {
  return Response.json({ error: code }, { status });
}
