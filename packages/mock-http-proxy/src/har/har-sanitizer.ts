/**
 * HAR entry sanitizer — redacts secrets from recorded HAR entries before they
 * are stored in the in-memory journal.
 *
 * ## Architecture
 *
 * Sanitization runs at the HarEntry level, after the journal constructs the
 * entry object but before it is pushed into `har.log.entries`. This guarantees
 * that `recorder.getHar()` never returns unsanitized secrets — even if the
 * HAR is never written to disk.
 *
 * For WebSocket entries, messages accumulate in a transient local array during
 * the connection lifetime and are materialized into a single HarEntry only
 * when the connection closes. The sanitizer runs on that complete entry, so
 * secrets never enter the journal.
 *
 * ## What gets sanitized
 *
 * The default sanitizer (`createDefaultHarSanitizer`) covers:
 * - Request/response headers with sensitive names (authorization, cookie, etc.)
 *   with structural awareness: Bearer tokens redact only the credential part,
 *   Cookie/Set-Cookie headers redact only the values (preserving names and
 *   cookie attributes like Path, HttpOnly, etc.)
 * - URL query parameters with sensitive names (token, api_key, jwt, etc.)
 * - JSON request/response bodies — recursively redacts values at sensitive keys
 * - WebSocket text frames — JSON-aware redaction covering Discord Gateway
 *   Identify (op:2, d.token), GraphQL-over-WS connection_init payloads,
 *   Coinbase-style subscribe JWTs, and bearer token regex fallback
 *
 * ## Content-length consistency
 *
 * After body sanitization, the sanitizer updates `content.size`, `bodySize`,
 * and the `content-length` response header to be internally consistent with
 * the sanitized text. The original content length is preserved in an
 * `x-iterate-har-original-content-length` response header.
 *
 * ## getIterateSecret carve-out
 *
 * Values matching the `getIterateSecret({...})` placeholder pattern are safe
 * proxy tokens that never contain real secrets. They are preserved as-is.
 *
 * ## Redaction format
 *
 * Redacted values use a deterministic prefix-plus-hash format for debuggability:
 * `<prefix>---sanitised-secret-<8-char-hex-hash>` where the prefix is up to 30% of the original
 * string. See `formatSanitizedSecret` for details.
 */

import { createHash } from "node:crypto";
import type { Entry as HarEntry } from "har-format";
import type { HarEntryWithExtensions, HarWebSocketMessage } from "./har-extensions.ts";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "x-auth-token",
]);

const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  "token",
  "api_key",
  "apikey",
  "auth_token",
  "oauth_token",
  "oauth_signature",
  "access_token",
  "refresh_token",
  "id_token",
  "client_id",
  "client_secret",
  "code",
  "code_verifier",
  "code_challenge",
  "code_challenge_method",
  "assertion",
  "signature",
  "sig",
  "key",
  "jwt",
  "secret",
  "password",
  "state",
]);

const SENSITIVE_JSON_KEYS = new Set([
  "token",
  "secret",
  "password",
  "authorization",
  "client_secret",
  "client_id",
  "code",
  "code_verifier",
  "assertion",
  "oauth_token",
  "jwt",
  "id_token",
  "access_token",
  "refresh_token",
  "api_key",
  "apiKey",
]);

const ITERATE_SECRET_PATTERN = /getIterateSecret\(\s*\{[^}]+\}\s*\)/;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-/+=]+/g;

function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  if (/^x-[a-z0-9-]*key$/.test(lower)) return true;
  if (/^x-[a-z0-9-]*token$/.test(lower)) return true;
  return false;
}

/**
 * Returns true if `value` is a `getIterateSecret({...})` placeholder string.
 *
 * These are safe proxy tokens used by the iterate egress proxy to inject
 * secrets at request time. They never contain real secret values themselves,
 * so they should not be redacted in HAR recordings.
 */
export function isIterateSecretPlaceholder(value: string): boolean {
  return ITERATE_SECRET_PATTERN.test(value);
}

/**
 * Deterministic secret redaction that preserves a prefix for debuggability.
 *
 * Output format: `<prefix>---sanitised-secret-<hash>`
 * - `prefix`: the first `floor(value.length * 0.3)` characters of the original
 * - `---sanitised-secret-`: literal separator
 * - `hash`: first 8 hex characters of SHA-256 of the full original value
 *
 * This keeps enough of the original to identify what kind of secret it was
 * (e.g. "sk-pr" for an OpenAI key, "xoxb" for a Slack token) while making
 * it impossible to reconstruct the full value. The deterministic hash means
 * the same secret always produces the same redacted form, which is useful
 * for correlating entries across a HAR recording.
 *
 * Examples:
 * - `"sk-proj-abc123xyz"` (len 17, 30%=5) -> `"sk-pr---sanitised-secret-0f959513"`
 * - `"ab"` (len 2, 30%=0) -> `"---sanitised-secret-fb8e20fc"`
 * - `""` -> `"---sanitised-secret-e3b0c442"`
 */
export function formatSanitizedSecret(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  const prefixLen = Math.floor(value.length * 0.3);
  const prefix = value.slice(0, prefixLen);
  return `${prefix}---sanitised-secret-${hash}`;
}

/**
 * Verifies whether `candidate` is the redacted form of `originalSecret`.
 * Useful in tests to confirm a specific value was correctly sanitized.
 */
export function isRedactedSecret(candidate: string, originalSecret: string): boolean {
  return candidate === formatSanitizedSecret(originalSecret);
}

function maybeRedact(value: string): string {
  if (isIterateSecretPlaceholder(value)) return value;
  return formatSanitizedSecret(value);
}

/**
 * Structurally redact a Bearer-style Authorization header value.
 * Preserves the "Bearer " scheme prefix and redacts only the credential.
 * For non-Bearer values, redacts the whole value.
 */
function sanitizeAuthorizationValue(value: string): string {
  if (isIterateSecretPlaceholder(value)) return value;
  const bearerMatch = /^(Bearer\s+)(.+)$/i.exec(value);
  if (bearerMatch) {
    const credential = bearerMatch[2]!;
    if (isIterateSecretPlaceholder(credential)) return value;
    return `${bearerMatch[1]}${formatSanitizedSecret(credential)}`;
  }
  return formatSanitizedSecret(value);
}

/**
 * Structurally redact a Cookie header value.
 * Cookie headers have the form "name1=val1; name2=val2".
 * Preserves cookie names, redacts only values.
 */
function sanitizeCookieValue(value: string): string {
  if (isIterateSecretPlaceholder(value)) return value;
  return value
    .split("; ")
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return pair;
      const name = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);
      return `${name}=${maybeRedact(val)}`;
    })
    .join("; ");
}

/**
 * Structurally redact a Set-Cookie header value.
 * Set-Cookie has the form "name=value; Path=/; HttpOnly; ..."
 * Only the first name=value pair is the actual cookie; the rest are attributes
 * that should be preserved unchanged.
 */
function sanitizeSetCookieValue(value: string): string {
  if (isIterateSecretPlaceholder(value)) return value;
  const parts = value.split("; ");
  const first = parts[0] ?? "";
  const eqIdx = first.indexOf("=");
  if (eqIdx === -1) return formatSanitizedSecret(value);
  const name = first.slice(0, eqIdx);
  const val = first.slice(eqIdx + 1);
  const sanitizedFirst = `${name}=${maybeRedact(val)}`;
  return [sanitizedFirst, ...parts.slice(1)].join("; ");
}

function sanitizeHeaderValue(headerName: string, value: string): string {
  const lower = headerName.toLowerCase();
  if (lower === "authorization" || lower === "proxy-authorization") {
    return sanitizeAuthorizationValue(value);
  }
  if (lower === "cookie") {
    return sanitizeCookieValue(value);
  }
  if (lower === "set-cookie") {
    return sanitizeSetCookieValue(value);
  }
  return maybeRedact(value);
}

function sanitizeHeaderList(
  headers: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return headers.map((header) => {
    if (isSensitiveHeaderName(header.name)) {
      return { name: header.name, value: sanitizeHeaderValue(header.name, header.value) };
    }
    return header;
  });
}

function sanitizeQueryString(
  queryString: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return queryString.map((param) => {
    if (SENSITIVE_QUERY_PARAM_NAMES.has(param.name.toLowerCase())) {
      return { name: param.name, value: maybeRedact(param.value) };
    }
    return param;
  });
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_JSON_KEYS.has(key) && typeof val === "string") {
        result[key] = maybeRedact(val);
      } else {
        result[key] = sanitizeJsonValue(val);
      }
    }
    return result;
  }
  return value;
}

function sanitizeJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const sanitized = sanitizeJsonValue(parsed);
  return JSON.stringify(sanitized);
}

function sanitizeBearerTokens(text: string): string {
  return text.replace(BEARER_PATTERN, (match) => {
    if (isIterateSecretPlaceholder(match)) return match;
    return formatSanitizedSecret(match);
  });
}

function sanitizeWebSocketMessage(message: HarWebSocketMessage): HarWebSocketMessage {
  if (message.opcode !== 1) return message;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return { ...message, data: sanitizeBearerTokens(message.data) };
  }

  const sanitized = sanitizeJsonValue(parsed);
  return { ...message, data: JSON.stringify(sanitized) };
}

function findHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): { name: string; value: string } | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
}

function setOrAddHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
  value: string,
): Array<{ name: string; value: string }> {
  const existing = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0) {
    const result = [...headers];
    result[existing] = { name, value };
    return result;
  }
  return [...headers, { name, value }];
}

export type HarEntrySanitizer = (entry: HarEntry) => HarEntry;

/**
 * Creates the default HAR entry sanitizer.
 *
 * The returned function walks a `HarEntry` and redacts sensitive values in:
 *
 * - **Authorization headers**: structurally aware — preserves the "Bearer "
 *   scheme prefix and redacts only the credential portion.
 * - **Cookie headers**: preserves cookie names, redacts only values.
 *   Handles multiple cookies ("name1=val1; name2=val2").
 * - **Set-Cookie headers**: preserves the cookie name and attributes
 *   (Path, HttpOnly, etc.), redacts only the cookie value.
 * - **Other sensitive headers**: `x-api-key`, `x-auth-token` — full value
 *   redaction.
 * - **Query parameters**: `token`, `api_key`, `access_token`, `refresh_token`,
 *   `key`, `jwt`, `secret`, `password`
 * - **JSON request bodies** (`postData.text`): recursively redacts values at
 *   sensitive keys (`token`, `secret`, `password`, `authorization`,
 *   `client_secret`, `jwt`, `access_token`, `refresh_token`, `api_key`,
 *   `apiKey`). Non-JSON bodies are left unchanged.
 * - **JSON response bodies** (`content.text`): same recursive key walk.
 * - **WebSocket text frames** (`_webSocketMessages` with `opcode === 1`):
 *   JSON-aware redaction covering Discord Gateway Identify (`op:2`, `d.token`),
 *   GraphQL-over-WS `connection_init` payloads, and Coinbase-style `subscribe`
 *   JWTs. Non-JSON text frames get a regex fallback for bearer-style tokens.
 *   Binary frames (`opcode !== 1`) are untouched.
 *
 * After body sanitization, `content.size`, `bodySize`, and the
 * `content-length` response header are updated to match the sanitized text.
 * The original content length is preserved in an
 * `x-iterate-har-original-content-length` response header.
 *
 * Values matching the `getIterateSecret({...})` placeholder pattern are
 * preserved as-is (see `isIterateSecretPlaceholder`).
 */
export function createDefaultHarSanitizer(): HarEntrySanitizer {
  return (entry: HarEntry): HarEntry => {
    const sanitized = structuredClone(entry) as HarEntryWithExtensions;

    sanitized.request.headers = sanitizeHeaderList(sanitized.request.headers);
    sanitized.response.headers = sanitizeHeaderList(sanitized.response.headers);

    sanitized.request.queryString = sanitizeQueryString(sanitized.request.queryString);

    if (sanitized.request.postData?.text) {
      const originalRequestText = sanitized.request.postData.text;
      sanitized.request.postData.text = sanitizeJsonText(originalRequestText);
      const newRequestSize = Buffer.byteLength(sanitized.request.postData.text, "utf8");
      sanitized.request.bodySize = newRequestSize;
    }

    if (sanitized.response.content.text) {
      const originalResponseText = sanitized.response.content.text;
      sanitized.response.content.text = sanitizeJsonText(originalResponseText);
      const originalSize = Buffer.byteLength(originalResponseText, "utf8");
      const newSize = Buffer.byteLength(sanitized.response.content.text, "utf8");
      sanitized.response.content.size = newSize;
      sanitized.response.bodySize = newSize;

      const existingCL = findHeader(sanitized.response.headers, "content-length");
      if (existingCL) {
        sanitized.response.headers = setOrAddHeader(
          sanitized.response.headers,
          "content-length",
          String(newSize),
        );
      }

      sanitized.response.headers = setOrAddHeader(
        sanitized.response.headers,
        "x-iterate-har-original-content-length",
        String(originalSize),
      );
    }

    if (sanitized._webSocketMessages) {
      sanitized._webSocketMessages = sanitized._webSocketMessages.map(sanitizeWebSocketMessage);
    }

    return sanitized as HarEntry;
  };
}
