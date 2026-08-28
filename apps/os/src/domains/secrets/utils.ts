import { normalizePath } from "../durable-object-names.ts";

/**
 * The egress placeholder grammar. A request may carry
 * `getSecret("/secrets/…")` (substitute the whole material — which
 * must then be a string) or `getSecret("/secrets/…", { field: "a.b" })`
 * (substitute one dotted field of structured material). Substitution reaches
 * headers, the request URL PATH (for providers that carry the credential
 * there, e.g. Telegram's `/bot<token>/…`), and URL QUERY VALUES (for
 * providers that only take `?api_key=…`). An explicitly opted-in JSON body
 * may also carry exact-reference string values; embedded references, object
 * keys, query parameter names, and unmarked bodies are never substituted (see
 * apps/os/docs/integrations-and-secrets-design.md §1 and ADR 0005). A
 * placeholder anywhere else in the URL fails loudly at substitution instead
 * of leaking the literal reference string to the provider. The `field` key is
 * optional; omit it for whole-material (plain-string) secrets.
 *
 * Headers may also carry the placeholder inside a **Basic** Authorization
 * credential (`Authorization: Basic base64(user:getSecret(...))`). GitHub's
 * git-over-HTTPS smart HTTP endpoint only accepts Basic (not Bearer), so
 * sandbox git plants that shape; discovery and substitution peel the base64
 * payload so the placeholder stays findable without putting token bytes in
 * the container.
 */
const SECRET_REFERENCE = /getSecret\(\s*"([^"]+)"\s*(?:,\s*\{\s*field\s*:\s*"([^"]+)"\s*\})?\s*\)/g;
const EXACT_SECRET_REFERENCE =
  /^getSecret\(\s*"([^"]+)"\s*(?:,\s*\{\s*field\s*:\s*"([^"]+)"\s*\})?\s*\)$/;

export const SECRET_JSON_TEMPLATE_HEADER = "x-iterate-secret-template";
const MAX_SECRET_JSON_TEMPLATE_BYTES = 1024 * 1024;

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
export type PlatformReference = { platform: string };

export function normalizeSecretPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/secrets/")) {
    throw new SecretSubstitutionError(
      "secret_reference_invalid_path",
      `secret path must start with "/secrets/", got "${normalized}"`,
    );
  }
  // A secret path becomes a Durable Object name (`durable-object-names.ts`),
  // and that name is reparsed with WHATWG `URL` — which collapses `.`/`..`
  // segments and splits on `?`/`#`. So `/secrets/../agents/x` addresses one DO
  // but reparses to a DIFFERENT path than the one shown in audit/UI. Reject
  // anything non-canonical in this shared helper (every secret op flows
  // through it) so the addressed path and the displayed path cannot diverge.
  // eslint-disable-next-line no-control-regex -- control chars are exactly what we reject
  if (/[\u0000-\u0020\u007f?#%\\]/.test(normalized)) {
    throw new SecretSubstitutionError(
      "secret_reference_invalid_path",
      `secret path has an illegal character: "${normalized}"`,
    );
  }
  for (const segment of normalized.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new SecretSubstitutionError(
        "secret_reference_invalid_path",
        `secret path has an empty or dot segment: "${normalized}"`,
      );
    }
  }
  return normalized;
}

/** Every distinct placeholder across all headers. All must address the same
 * secret — the Secret DO rejects foreign paths (one request, one secret). */
export function secretReferencesFromHeaders(headers: Headers): SecretReference[] {
  const byKey = new Map<string, SecretReference>();
  headers.forEach((value) => collectSecretReferences(byKey, value));
  return [...byKey.values()];
}

/** Every distinct placeholder across all headers AND the request URL. The
 * request-level view of {@link secretReferencesFromHeaders} — URL placeholders
 * exist for providers whose credential lives in the URL path (Telegram) or
 * its query (`?api_key=…`). Deliberately scans the WHOLE url, including the
 * parts substitution refuses: a placeholder in the fragment must still route
 * to the Secret DO, where substitution rejects it loudly (see
 * {@link substituteSecretRequest}) instead of the request sailing through
 * egress with the literal placeholder in it. */
export async function secretReferencesFromRequest(
  request: Request,
): Promise<{ problems: SecretSubstitutionError[]; references: SecretReference[] }> {
  const byKey = new Map<string, SecretReference>();
  try {
    request.headers.forEach((value) => collectSecretReferences(byKey, value));
    collectSecretReferences(byKey, decodedUrl(request.url));
    const jsonTemplate = await inspectSecretJsonTemplate(request);
    if (jsonTemplate.problem !== undefined) {
      return { problems: [jsonTemplate.problem], references: [...byKey.values()] };
    }
    if (jsonTemplate.value !== undefined) collectJsonSecretReferences(byKey, jsonTemplate.value);
    return { problems: [], references: [...byKey.values()] };
  } catch (error) {
    if (
      error instanceof SecretSubstitutionError &&
      error.code === "secret_reference_invalid_path"
    ) {
      return { problems: [error], references: [...byKey.values()] };
    }
    throw error;
  }
}

/** The distinct secret PATHS referenced across a request's headers, URL, and
 * explicitly opted-in JSON body —
 * used by the project egress door to pick which Secret DO to hand the request
 * to (exactly one; multi-secret requests are not supported) and as a cheap
 * presence check. */
export async function secretReferencePathsFromRequest(
  request: Request,
): Promise<{ paths: string[]; problems: SecretSubstitutionError[] }> {
  const { problems, references } = await secretReferencesFromRequest(request);
  return { paths: [...new Set(references.map((reference) => reference.path))], problems };
}

function collectSecretReferences(byKey: Map<string, SecretReference>, value: string): void {
  for (const candidate of headerValuesForSecretScan(value)) {
    for (const match of candidate.matchAll(SECRET_REFERENCE)) {
      const path = normalizeSecretPath(match[1]!);
      const field = match[2];
      byKey.set(`${path} ${field ?? ""}`, field === undefined ? { path } : { field, path });
    }
  }
}

function collectJsonSecretReferences(byKey: Map<string, SecretReference>, value: unknown): void {
  if (typeof value === "string") {
    const match = EXACT_SECRET_REFERENCE.exec(value);
    if (match === null) return;
    const path = normalizeSecretPath(match[1]!);
    const field = match[2];
    byKey.set(`${path} ${field || ""}`, field === undefined ? { path } : { field, path });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonSecretReferences(byKey, item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const item of Object.values(value)) collectJsonSecretReferences(byKey, item);
}

/**
 * Values to scan for `getSecret(...)` placeholders: the raw header string,
 * plus — when the header is HTTP Basic auth — the base64-decoded credential
 * payload. Git (and anything else that only speaks Basic) base64-encodes
 * `username:password` into `Authorization: Basic …`; without peeling that
 * layer the placeholder inside the password is invisible to discovery and
 * substitution.
 */
function headerValuesForSecretScan(value: string): string[] {
  const decoded = decodeBasicAuthorizationCredential(value);
  return decoded === null ? [value] : [value, decoded.credential];
}

/**
 * Peel `Authorization: Basic <base64>` into its decoded `user:pass` payload.
 * Returns null when the value is not Basic or the base64 is invalid. Callers
 * re-encode with `btoa` after substitution (placeholders and tokens are
 * ASCII, so the latin1 btoa/atob pair is the right codec).
 */
function decodeBasicAuthorizationCredential(
  value: string,
): { prefix: string; encoded: string; suffix: string; credential: string } | null {
  const match = /^(\s*[Bb]asic\s+)([A-Za-z0-9+/]+=*)(\s*)$/.exec(value);
  if (match === null) return null;
  try {
    return {
      prefix: match[1]!,
      encoded: match[2]!,
      suffix: match[3]!,
      credential: atob(match[2]!),
    };
  } catch {
    return null;
  }
}

/** Substitute every path-based `getSecret(...)` match in a plain header value. */
function substituteSecretPlaceholdersInText(
  value: string,
  resolve: (reference: SecretReference) => string,
): string {
  return substituteSecretPlaceholders(value, resolve).value;
}

/**
 * Substitute placeholders in one header value, including inside Basic auth
 * base64 payloads. Non-Basic headers (Bearer, custom) substitute in place;
 * Basic peels → substitutes the credential → re-encodes so the provider sees
 * a real `user:token` pair.
 */
function substituteSecretPlaceholdersInHeaderValue(
  value: string,
  resolve: (reference: SecretReference) => string,
): string {
  const basic = decodeBasicAuthorizationCredential(value);
  if (basic !== null) {
    const substituted = substituteSecretPlaceholdersInText(basic.credential, resolve);
    if (substituted !== basic.credential) {
      return `${basic.prefix}${btoa(substituted)}${basic.suffix}`;
    }
    // No placeholder in the credential — still run plain substitution in case
    // the scheme/prefix somehow carried one (it shouldn't), then return.
  }
  return substituteSecretPlaceholdersInText(value, resolve);
}

/**
 * A request URL as placeholder-matchable text. URL parsing percent-encodes the
 * placeholder's quotes (and its options object's braces/spaces when present),
 * so matching and substitution run on the decoded form. Returns the input
 * unchanged when it does not decode (a stray `%` outside any escape).
 */
function decodedUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** Every distinct platform-credential placeholder across all headers. */
export function platformReferencesFromHeaders(headers: Headers): PlatformReference[] {
  const byPath = new Map<string, PlatformReference>();
  headers.forEach((value) => {
    for (const candidate of headerValuesForSecretScan(value)) {
      for (const match of candidate.matchAll(PLATFORM_REFERENCE)) {
        byPath.set(match[1]!, { platform: match[1]! });
      }
    }
  });
  return [...byPath.values()];
}

/** Rewrites every `getSecret({ platform: ... })` placeholder in every header
 * using `resolve`. Runs in trusted platform code (the project egress door).
 * Peels Basic Authorization base64 the same way path-secret substitution does. */
export function substitutePlatformHeaders(
  request: Request,
  resolve: (reference: PlatformReference) => string,
): Request {
  const headers = new Headers(request.headers);
  headers.forEach((value, name) => {
    headers.set(name, substitutePlatformPlaceholdersInHeaderValue(value, resolve));
  });
  return new Request(request, { headers });
}

function substitutePlatformPlaceholdersInText(
  value: string,
  resolve: (reference: PlatformReference) => string,
): string {
  return value.replaceAll(PLATFORM_REFERENCE, (_match, platform: string) => resolve({ platform }));
}

function substitutePlatformPlaceholdersInHeaderValue(
  value: string,
  resolve: (reference: PlatformReference) => string,
): string {
  const basic = decodeBasicAuthorizationCredential(value);
  if (basic !== null) {
    const substituted = substitutePlatformPlaceholdersInText(basic.credential, resolve);
    if (substituted !== basic.credential) {
      return `${basic.prefix}${btoa(substituted)}${basic.suffix}`;
    }
  }
  return substitutePlatformPlaceholdersInText(value, resolve);
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
 *
 * Basic Authorization headers are special: the placeholder may live inside
 * the base64 credential (`user:getSecret(...)`). That shape is required for
 * GitHub git-over-HTTPS (Bearer is rejected with 401). Decode → substitute →
 * re-encode so providers see a real token while the container still only held
 * the placeholder.
 */
export function substituteSecretHeaders(
  request: Request,
  resolve: (reference: SecretReference) => string,
): Request {
  const headers = new Headers(request.headers);
  headers.forEach((value, name) => {
    headers.set(name, substituteSecretPlaceholdersInHeaderValue(value, resolve));
  });
  return new Request(request, { headers });
}

/**
 * Rewrites every `getSecret(...)` placeholder in every header, the request
 * URL's PATH and QUERY VALUES, and exact string values in an explicitly
 * opted-in JSON body.
 *
 * Path substitution exists for providers that authenticate in the URL path
 * (Telegram's `/bot<token>/<method>`; there is no header auth). Query
 * substitution exists for the many APIs that only take their credential as
 * `?api_key=…`. Both are opt-in by the caller writing the placeholder there,
 * and both keep the credential out of OUR records: the `secret/used` audit
 * event stores the request URL BEFORE substitution, so what is kept is the
 * `getSecret(...)` reference, never the material. What the caller is choosing
 * is the provider's side of it — a credential in a query string lands in the
 * provider's access logs (and any intermediary's) in a way a header does not.
 *
 * Everything else in the URL still throws: query parameter NAMES (same rule
 * as JSON object keys), the fragment, userinfo, and the host. Silently
 * passing a literal placeholder through to the provider would leak the
 * reference string and come back as a confusing provider-side 401.
 *
 * Matching runs on the decoded part (see {@link decodedUrl}); a path or query
 * carrying no placeholder stays byte-identical, so nothing re-encodes a URL
 * it did not need to touch.
 */
export async function substituteSecretRequest(
  request: Request,
  resolve: (reference: SecretReference) => string,
): Promise<Request> {
  const inspectedJsonTemplate = await inspectSecretJsonTemplate(request);
  if (inspectedJsonTemplate.problem !== undefined) throw inspectedJsonTemplate.problem;
  const jsonTemplate = inspectedJsonTemplate.value;
  let substituted = substituteSecretHeaders(request, resolve);
  if (jsonTemplate !== undefined) {
    const headers = new Headers(substituted.headers);
    headers.delete(SECRET_JSON_TEMPLATE_HEADER);
    headers.delete("content-length");
    substituted = new Request(substituted, {
      body: JSON.stringify(substituteSecretJsonValues(jsonTemplate, resolve)),
      headers,
    });
  }
  const url = new URL(request.url);
  for (const [part, value] of [
    ["fragment", url.hash],
    ["username", url.username],
    ["password", url.password],
    ["host", url.host],
  ] as const) {
    if (decodedUrl(value).match(SECRET_REFERENCE) !== null) {
      throw new SecretSubstitutionError(
        "secret_reference_outside_url_path",
        `getSecret(...) placeholders in a request URL are only substituted in the path and query values; found one in the ${part}`,
      );
    }
  }
  // Each URL part reports its own hit: re-serialising a part changes its
  // encoding (`%20` → `+` in a query, percent-escapes in a path), so a part
  // that carried no placeholder is left exactly as it arrived — a path
  // placeholder must not quietly re-encode an innocent query, or vice versa.
  const path = substituteSecretPlaceholders(decodedUrl(url.pathname), resolve);

  // Query params are rewritten pair by pair over the RAW query text, not
  // through URLSearchParams. Two reasons, both about `+`: that decoder is
  // form-urlencoded, so it reads a literal `+` as a space — which would
  // rewrite the path a placeholder names (`/secrets/a+b` → `/secrets/a b`)
  // and 400 on a path that works fine in a header, while discovery, which
  // reads the URL as RFC 3986, had already routed the request to the real
  // secret. And re-serialising through it would flip `%20` to `+` in
  // untouched params. Splitting the text keeps every pair we do not rewrite
  // byte-identical.
  let queryHasPlaceholder = false;
  const rewrittenPairs = queryPairs(url.search).map((pair) => {
    const equals = pair.indexOf("=");
    if (decodedUrl(equals === -1 ? pair : pair.slice(0, equals)).match(SECRET_REFERENCE) !== null) {
      throw new SecretSubstitutionError(
        "secret_reference_outside_url_path",
        "getSecret(...) placeholders in a request URL are only substituted in the path and query values; found one in a query parameter name",
      );
    }
    if (equals === -1) return pair;
    const value = substituteSecretPlaceholders(decodedUrl(pair.slice(equals + 1)), resolve);
    if (!value.hasPlaceholder) return pair;
    queryHasPlaceholder = true;
    // `+` is escaped explicitly: encodeURIComponent leaves it alone, and a
    // provider reading the query as form-urlencoded would take a literal `+`
    // in the material for a space.
    return `${pair.slice(0, equals)}=${encodeURIComponent(value.value).replaceAll("+", "%2B")}`;
  });

  if (!path.hasPlaceholder && !queryHasPlaceholder) return substituted;
  if (path.hasPlaceholder) url.pathname = path.value;
  if (queryHasPlaceholder) url.search = rewrittenPairs.join("&");
  return new Request(url.toString(), substituted);
}

/** The `name=value` pairs of a raw query string (no leading `?`, no decoding). */
function queryPairs(search: string): string[] {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return query === "" ? [] : query.split("&");
}

/** Substitute every `getSecret(...)` placeholder in one already-decoded
 * string, reporting whether it held any — URL substitution only re-serialises
 * the parts that did. */
function substituteSecretPlaceholders(
  value: string,
  resolve: (reference: SecretReference) => string,
): { hasPlaceholder: boolean; value: string } {
  let hasPlaceholder = false;
  const substituted = value.replaceAll(
    SECRET_REFERENCE,
    (_match, path: string, field: string | undefined) => {
      hasPlaceholder = true;
      return resolve(
        field === undefined
          ? { path: normalizeSecretPath(path) }
          : { field, path: normalizeSecretPath(path) },
      );
    },
  );
  return { hasPlaceholder, value: substituted };
}

async function inspectSecretJsonTemplate(
  request: Request,
): Promise<{ problem?: SecretSubstitutionError; value?: unknown }> {
  const mode = request.headers.get(SECRET_JSON_TEMPLATE_HEADER);
  if (mode === null) return {};
  if (mode !== "json") {
    return { problem: new SecretSubstitutionError("secret_json_template_invalid_mode") };
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    return { problem: new SecretSubstitutionError("secret_json_template_invalid_content_type") };
  }
  const inspectedBody = await readSecretJsonTemplateBody(request);
  if (inspectedBody.problem !== undefined) return inspectedBody;
  try {
    return { value: JSON.parse(inspectedBody.body) as unknown };
  } catch {
    return { problem: new SecretSubstitutionError("secret_json_template_invalid_body") };
  }
}

async function readSecretJsonTemplateBody(
  request: Request,
): Promise<
  { body: string; problem?: undefined } | { body?: undefined; problem: SecretSubstitutionError }
> {
  const stream = request.clone().body;
  if (stream === null) return { body: "" };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return { body: body + decoder.decode() };
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_SECRET_JSON_TEMPLATE_BYTES) {
      void reader.cancel();
      return { problem: new SecretSubstitutionError("secret_json_template_body_too_large") };
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
}

function substituteSecretJsonValues(
  value: unknown,
  resolve: (reference: SecretReference) => string,
): unknown {
  if (typeof value === "string") {
    const match = EXACT_SECRET_REFERENCE.exec(value);
    if (match === null) return value;
    const path = normalizeSecretPath(match[1]!);
    const field = match[2];
    return resolve(field === undefined ? { path } : { field, path });
  }
  if (Array.isArray(value)) return value.map((item) => substituteSecretJsonValues(item, resolve));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, substituteSecretJsonValues(item, resolve)]),
  );
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
  | "secret_fetch_failed"
  | "secret_json_template_body_too_large"
  | "secret_json_template_invalid_body"
  | "secret_json_template_invalid_content_type"
  | "secret_json_template_invalid_mode"
  | "secret_material_not_a_string"
  | "secret_not_allowed_for_origin"
  | "secret_not_found"
  | "secret_reference_field_not_found"
  | "secret_reference_foreign"
  | "secret_reference_invalid_path"
  | "secret_reference_outside_url_path"
  | "secret_reference_required";

/** A substitution failure carrying a stable code so the egress path can answer
 * a 4xx instead of leaking an exception. `detail` (message-only) names the
 * specifics — e.g. which URL part held a disallowed placeholder. */
export class SecretSubstitutionError extends Error {
  readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.code = code;
    this.name = "SecretSubstitutionError";
  }
}

/** The one code→status mapping: a destination outside the pin is forbidden
 * (403); every other substitution failure is a bad request (400). */
export function secretErrorResponse(code: SecretErrorCode): Response {
  return Response.json(
    { error: code },
    {
      status:
        code === "secret_fetch_failed" ? 502 : code === "secret_not_allowed_for_origin" ? 403 : 400,
    },
  );
}

/**
 * Every project is born with a write-only ingress credential at this path:
 * the value the `project-secret` /api credential is verified against (inside
 * the Secret Durable Object — material never leaves the secret system; the
 * verifier's answer is one bit). Born with an EMPTY egress pin, so unlike
 * every other secret it can never be substituted into any outbound request:
 * the ingress key and any egress credentials an external app is dialed with
 * are deliberately different secrets.
 */
export const PROJECT_API_KEY_SECRET_PATH = "/secrets/project-api-key";

/** Random birth material for {@link PROJECT_API_KEY_SECRET_PATH}. Unusable
 * until the owner overwrites it with a value they hold (secrets.update) —
 * writing a known value IS the pairing ceremony with an external app. */
export function generateProjectApiKeyMaterial(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `itxk_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
