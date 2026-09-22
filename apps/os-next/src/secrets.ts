// secrets.ts — a project secret, the pure half: what a secret IS (material + a URL pin + an optional
// refresh strategy), the placeholder grammar egress substitutes, and the two refresh strategies,
// each a plain function of (strategy, material, fetch). No Cloudflare import — the node unit tests
// cover every row — and only erasable TypeScript syntax, so a type-stripping loader can take it. The
// host that keeps a record and runs these is the secret facet (secret/durable-object.ts); the verbs
// that write one are `itx.secrets` (context/built-ins.ts).
//
// The invariant, apps/os's (apps/os/docs/adr/0005-the-secret-cell-invariant.md), carried over whole:
// material goes in; nothing comes out except a request to a pinned host. Refresh runs INSIDE the
// secret's own facet — a named strategy in trusted code whose exchange endpoint must itself
// be pinned — so a credential that expires (an OAuth access token, a Waitrose session) is one secret,
// not a worker.

// The four shapes a caller sees — the material, the client-auth method, the refresh strategy and
// the catalog entry — are the SDK's (`iterate/next/api`, where the dash and every client read them);
// re-exported so the rest of os-next keeps one import for everything a secret is.
import type {
  ClientAuth,
  SecretCatalogEntry,
  SecretMaterial,
  SecretRefresh,
} from "iterate/next/api";
export type { ClientAuth, SecretCatalogEntry, SecretMaterial, SecretRefresh };

/** What the secret's facet stores: the material, the ORIGINS it may be sent to (never
 *  empty — a secret is always pinned), and the refresh strategy or none. */
export type SecretRecord = {
  material: SecretMaterial;
  urls: string[];
  refresh: SecretRefresh | null;
};

/** A secret IS its path, and the path is what the placeholder spells: `/secrets/<name>`, the name
 *  `[a-zA-Z0-9._-]+` — under the resource owner's root (a user's own secret lives at
 *  `/users/<id>/secrets/<name>`; the placeholder still spells `/secrets/<name>`). */
const SECRET_PATH = /^\/secrets\/[a-zA-Z0-9._-]+$/;

export function assertSecretPath(path: string): string {
  if (!SECRET_PATH.test(path))
    throw new Error(
      `secrets: a secret's path is /secrets/<name>, the name [a-zA-Z0-9._-]+ (what getSecret("/secrets/<name>") can spell), got ${JSON.stringify(path)}`,
    );
  return path;
}

/** A plain JSON object — not an array, which `typeof` also calls an object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && !!value && !Array.isArray(value);
}

const REFRESH_KINDS: readonly SecretRefresh["kind"][] = ["oauth-refresh-token", "waitrose-session"];
const CLIENT_AUTHS: readonly ClientAuth[] = ["client_secret_basic", "client_secret_post", "none"];

/** The strategy kinds implemented — the one place a kind is admitted from untyped input (a `set`
 *  option). */
export function isRefreshKind(kind: unknown): kind is SecretRefresh["kind"] {
  return REFRESH_KINDS.some((known) => known === kind);
}

/** The client-auth method as given, or the default; anything else is refused by name. */
export function clientAuthOf(value: unknown): ClientAuth {
  if (value === undefined) return "client_secret_basic";
  const known = CLIENT_AUTHS.find((method) => method === value);
  if (!known)
    throw new Error(
      `secrets: clientAuth is one of ${CLIENT_AUTHS.join(", ")} (RFC 8414 token_endpoint_auth_methods_supported), got ${JSON.stringify(value)}`,
    );
  return known;
}

/** The ORIGINS of a list of URLs, deduplicated — what a pin stores (a path or query on one is dropped). */
export function originsOf(urls: unknown): string[] {
  if (!Array.isArray(urls)) throw new Error("secrets: urls is a list of URLs");
  return [...new Set(urls.map((url) => new URL(String(url)).origin))];
}

/** The record as `itx.secrets.set(path, material, { urls, refresh? })` spells it, validated and
 *  normalized: the pin is required and stored as origins, the strategy is one of the named kinds
 *  with an http(s) endpoint that falls within the pin. */
export function normalizeSecretRecord(
  material: unknown,
  options: { urls?: unknown; refresh?: unknown } | undefined,
): SecretRecord {
  if (typeof material !== "string" && !isRecord(material))
    throw new Error("secrets: material is a string or a JSON object");
  const urls = options?.urls === undefined ? [] : originsOf(options.urls);
  if (urls.length === 0)
    throw new Error(
      "secrets: urls is required — the origins this secret may be sent to; a secret is never sent anywhere else",
    );
  let refresh: SecretRefresh | null = null;
  if (options?.refresh) {
    if (!isRecord(options.refresh) || !isRefreshKind(options.refresh.kind))
      throw new Error(
        `secrets: refresh.kind is one of ${REFRESH_KINDS.join(", ")}, got ${JSON.stringify(isRecord(options.refresh) ? options.refresh.kind : options.refresh)}`,
      );
    const kind = options.refresh.kind;
    const endpointKey = kind === "oauth-refresh-token" ? "tokenEndpoint" : "graphqlUrl";
    const endpoint = new URL(String(options.refresh[endpointKey]));
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
      throw new Error(`secrets: refresh.${endpointKey} must be an http(s) URL`);
    if (!urls.includes(endpoint.origin))
      throw new Error(
        `secrets: refresh.${endpointKey} ${endpoint.origin} is outside the pin ${urls.join(", ")} — a refresh only ever sends the material toward a pinned host`,
      );
    refresh =
      kind === "oauth-refresh-token"
        ? {
            kind,
            tokenEndpoint: endpoint.href,
            clientAuth: clientAuthOf(options.refresh.clientAuth),
          }
        : { kind, graphqlUrl: endpoint.href };
  }
  return { material, urls, refresh };
}

// ── the placeholder grammar ── apps/os's (apps/os/src/domains/secrets/utils.ts) for a URL or a header:
// `getSecret("/secrets/NAME")` is the whole stored value; `getSecret("/secrets/NAME", { field: "a.b" })`
// is one dotted field of a JSON-valued secret. Double quotes, whitespace free inside the
// parentheses; `/secrets/NAME` is the PATH `itx.secrets.set("/secrets/NAME", …)` stored. Matched as written in a
// header, and as the URL parser percent-encodes it in a URL (`"` → %22, a space → %20, `{` → %7B, `}`
// → %7D) — the path and the query alike; the value is spliced back into the URL as ONE component,
// `:` kept (Telegram's `bot123:abc` path). Where this DIVERGES from apps/os: no peeling of a `Basic
// base64(user:getSecret(…))` credential, no JSON-body template — the body is never scanned.
const QUOTE = '(?:"|%22)';
const SPACE = "(?:\\s|%20)*";
const SECRET_PLACEHOLDER = new RegExp(
  `getSecret\\(${SPACE}${QUOTE}(/secrets/[a-zA-Z0-9._-]+)${QUOTE}${SPACE}` +
    `(?:,${SPACE}(?:\\{|%7B)${SPACE}field${SPACE}:${SPACE}${QUOTE}([^"%\\s]+)${QUOTE}${SPACE}(?:\\}|%7D))?${SPACE}\\)`,
  "g",
);

/** The placeholder as a caller wrote it, for a refusal that names it. */
const placeholderOf = (path: string, field: string | undefined): string =>
  !field ? `getSecret("${path}")` : `getSecret("${path}", { field: "${field}" })`;

/** A placeholder the secret cannot honour — no secret stored, a `field` the material has no string
 *  at, a secret pinned to other origins — answered with a 502 to the CALLER, never the destination.
 *  `mintable` marks the two misses a refresh strategy can fill (no material yet, a field not there
 *  yet): the mint-on-first-use. */
export class ProjectSecretRefused extends Error {
  readonly mintable: boolean;
  // A plain field, not a parameter property: only erasable syntax in this module (the header).
  constructor(message: string, mintable = false) {
    super(message);
    this.mintable = mintable;
  }
}

/** The string `field` (a dotted path) selects in `material`; refused when the material is not JSON
 *  or the path does not land on a string. */
function secretFieldOf(
  material: SecretMaterial,
  field: string,
  placeholder: string,
  where: string,
): string {
  let value: unknown = material;
  if (typeof material === "string") {
    try {
      value = JSON.parse(material);
    } catch {
      throw new ProjectSecretRefused(
        `itx.fetch: ${placeholder} in ${where} names a field, but the secret is not a JSON value`,
      );
    }
  }
  for (const segment of field.split(".")) value = isRecord(value) ? value[segment] : undefined;
  if (typeof value !== "string")
    throw new ProjectSecretRefused(
      `itx.fetch: ${placeholder} in ${where}: the secret has no string at field "${field}"`,
      true,
    );
  return value;
}

/** The DISTINCT secret paths a request's URL and headers reference — how egress knows which
 *  secret's context a request belongs to (one request, one secret). */
export function secretPathsReferenced(request: Request): string[] {
  const paths = new Set<string>();
  const scan = (value: string) => {
    if (!value.includes("getSecret(")) return;
    for (const [, path = ""] of value.matchAll(SECRET_PLACEHOLDER)) paths.add(path);
  };
  scan(request.url);
  for (const [, value] of request.headers) scan(value);
  return [...paths];
}

/**
 * Substitute every `getSecret("/secrets/<name>")` placeholder in the request URL AND headers. An
 * existing secret must never survive as a literal placeholder wherever it appears (a URL
 * `?access_token=getSecret("/secrets/token")` would otherwise send the credential's NAME to the
 * destination and the value nowhere); a placeholder with NO stored secret throws
 * `ProjectSecretRefused` naming the placeholder and where it sat — to the caller, never the
 * destination. `resolve(path)` answers the stored material; a `{ field }` placeholder then picks one
 * string out of it; an OBJECT material with no `field` is refused (a whole object is never a header).
 * In the URL the value is spliced as ONE component (`encodeURIComponent`, with `:` kept — a Telegram
 * bot token in the path), so a secret can never add a query parameter or a fragment. Returns a NEW
 * Request when anything changed, else the original.
 *
 * NOTE: the BODY is not scanned (substituting a streaming body means buffering it and recomputing
 * content-length) — a secret spelled inside a request body forwards as a literal placeholder.
 */
export async function substituteProjectSecrets(
  request: Request,
  resolve: (path: string) => Promise<SecretMaterial | null> | SecretMaterial | null,
): Promise<Request> {
  // Substitute the placeholders in one string; null = none in it (leave as-is).
  const substitute = async (value: string, where: string, encode: boolean) => {
    if (!value.includes("getSecret(")) return null;
    let out = "";
    let last = 0;
    let any = false;
    for (const m of value.matchAll(SECRET_PLACEHOLDER)) {
      // The two capture groups: the path (always present on a match), the optional field.
      const [, path = "", field] = m;
      const placeholder = placeholderOf(path, field);
      const stored = await resolve(path);
      // oxlint-disable-next-line iterate/simple-truthiness-check -- null means no secret is stored; a stored empty-string value is a real secret and must be substituted, not refused
      if (stored == null)
        throw new ProjectSecretRefused(
          `itx.fetch: no stored project secret for ${placeholder} in ${where}`,
          true,
        );
      let secret: string;
      if (field) secret = secretFieldOf(stored, field, placeholder, where);
      else if (typeof stored === "string") secret = stored;
      else
        throw new ProjectSecretRefused(
          `itx.fetch: ${placeholder} in ${where} names no field, but the secret is a JSON object — pick one with { field: "…" }`,
        );
      out +=
        value.slice(last, m.index) +
        (encode ? encodeURIComponent(secret).replaceAll("%3A", ":") : secret);
      last = m.index + m[0].length;
      any = true;
    }
    return any ? out + value.slice(last) : null;
  };

  // URL first: rebuild onto the new URL (carrying method/headers/body/upgrade), then headers on top.
  const url = await substitute(request.url, "the request URL", true);
  const base = url ? new Request(url, request) : request;
  const headers = new Headers(base.headers);
  let changed = false;
  for (const [name, value] of base.headers) {
    const substituted = await substitute(value, `header "${name}"`, false);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- substitute() returns null for "no placeholder here"; a substituted-to-empty header ("") is a real change and must be written, not skipped
    if (substituted !== null) {
      headers.set(name, substituted);
      changed = true;
    }
  }
  return changed ? new Request(base, { headers }) : base;
}

// ── the pin ──

/** A secret is sent to its pinned origins ONLY — a mis-typed URL cannot mail a credential to a
 *  stranger, and an app that forwards a visitor's headers cannot be made to mail it either. */
/** What `itx.secrets.verifyHmac(path, …)` takes: the bytes a webhook signed (a string is its UTF-8),
 *  the hex HMAC-SHA256 it sent, and which field of a JSON material is the key (the whole material
 *  when omitted). Stripe signs `${t}.${body}`, GitHub the body (`sha256=<hex>`), Slack `v0:${t}:${body}`;
 *  the caller assembles the signed bytes and strips the scheme prefix. */
export type SecretHmacVerification = {
  payload: string | Uint8Array;
  signature: string;
  field?: string;
};

/** The material as an HMAC key: the whole value when it is a string and no field is named, else the
 *  string at `field` of a JSON material (an object, or a string that parses as one). Anything else —
 *  an object with no field named, a field with no string at it — is null: no key, so nothing verifies. */
export function secretMaterialStringOf(material: SecretMaterial, field?: string): string | null {
  if (!field) return typeof material === "string" ? material : null;
  let value: unknown = material;
  if (typeof material === "string") {
    try {
      value = JSON.parse(material);
    } catch {
      return null;
    }
  }
  for (const segment of field.split(".")) value = isRecord(value) ? value[segment] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Hex HMAC-SHA256 of `payload` under `key` — the webhook-signature primitive (apps/os's
 *  `computeHmacHex`). WebCrypto, present in every isolate. */
export async function hmacSha256Hex(key: string, payload: string | Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, bytes as BufferSource);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality of two strings (apps/os's `constantTimeStringEquals`): HMAC both under one
 *  throwaway key and compare the fixed-length digests with no early exit, so neither content nor
 *  LENGTH shapes the timing — the candidate comes from an unauthenticated door. */
export async function constantTimeEquals(expected: string, candidate: string): Promise<boolean> {
  // a symmetric algorithm mints one key, not a pair — the union in the types is for RSA/EC
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])) as CryptoKey;
  const encoder = new TextEncoder();
  const [a, b] = (
    await Promise.all([
      crypto.subtle.sign("HMAC", key, encoder.encode(expected)),
      crypto.subtle.sign("HMAC", key, encoder.encode(candidate)),
    ])
  ).map((digest) => new Uint8Array(digest));
  let difference = 0;
  for (let i = 0; i < a!.length; i += 1) difference |= a![i]! ^ b![i]!;
  return difference === 0;
}

/** THE VERIFY LANE, pure: does `signature` (hex, either case) equal the HMAC-SHA256 of `payload`
 *  under the key `material` holds (at `field`)? One bit out; the key never leaves the caller. A
 *  material with no key at the field verifies nothing. */
export async function verifySecretHmac(
  material: SecretMaterial,
  input: SecretHmacVerification,
): Promise<boolean> {
  const key = secretMaterialStringOf(material, input.field);
  if (!key) return false;
  const signature = input.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return constantTimeEquals(await hmacSha256Hex(key, input.payload), signature);
}

export function originPinned(url: string, urls: string[]): boolean {
  return urls.includes(new URL(url).origin);
}

export function pinRefusal(path: string, url: string, urls: string[]): ProjectSecretRefused {
  return new ProjectSecretRefused(
    `itx.fetch: the secret ${path} is pinned to ${urls.join(", ")} — not sent to ${new URL(url).origin}`,
  );
}

// ── the refresh strategies ── each a pure function of (strategy, material, fetch): read the
// material, POST within the pin, return the NEXT material. The host (secret/durable-object.ts) runs
// ONE at a time per secret and stores the answer. A credential never appears in an error message.

/** The material as a record — a JSON string parses, a plain string has no fields. */
function materialRecordOf(material: SecretMaterial | null): Record<string, unknown> {
  if (!material) return {};
  if (typeof material !== "string") return material;
  try {
    const parsed: unknown = JSON.parse(material);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringField(record: Record<string, unknown>, field: string, kind: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "")
    throw new Error(`${kind}: the secret's material has no "${field}"`);
  return value;
}

/** The Waitrose Android app's login mutation, verbatim (apps/os carries the same string). */
const WAITROSE_NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";

/** A provider's JSON answer, read as a record — anything else (not JSON, a bare value) is `{}`, so
 *  every field read below falls through to the "returned no …" refusal. */
async function jsonRecordOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) ? body : {};
}

/** ONE request to an OAuth token endpoint — the refresh grant here, the authorization-code grant in
 *  secret-oauth.ts — with the client credential the way the endpoint wants it (`ClientAuth`); a
 *  client with no secret is treated as `none` whatever it declared. */
export function oauthTokenRequest(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  clientAuth: ClientAuth;
  params: Record<string, string>;
}): Request {
  const method = input.clientSecret ? input.clientAuth : "none";
  const body = new URLSearchParams(input.params);
  if (method !== "client_secret_basic") body.set("client_id", input.clientId);
  if (method === "client_secret_post") body.set("client_secret", input.clientSecret);
  return new Request(input.tokenEndpoint, {
    method: "POST",
    headers: {
      ...(method === "client_secret_basic" && {
        authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
      }),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
}

/** The tokens a token endpoint answered with — `accessToken`, and `refreshToken` when it issued (or
 *  rotated) one. A refusal or a bodyless answer throws, naming the grant, never a credential. */
export async function oauthTokensOf(
  response: Response,
  grant: string,
): Promise<{ accessToken: string; refreshToken?: string }> {
  if (!response.ok) throw new Error(`${grant}: the token endpoint answered ${response.status}`);
  const data = await jsonRecordOf(response);
  if (typeof data.access_token !== "string")
    throw new Error(`${grant}: the token endpoint returned no access_token`);
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
  };
}

export async function refreshSecretMaterial(
  refresh: SecretRefresh,
  material: SecretMaterial | null,
  fetchFn: (request: Request) => Promise<Response>,
): Promise<Record<string, unknown>> {
  const record = materialRecordOf(material);
  if (refresh.kind === "oauth-refresh-token") {
    const refreshToken = stringField(record, "refreshToken", refresh.kind);
    const clientId = stringField(record, "clientId", refresh.kind);
    const clientSecret = typeof record.clientSecret === "string" ? record.clientSecret : "";
    const response = await fetchFn(
      oauthTokenRequest({
        tokenEndpoint: refresh.tokenEndpoint,
        clientId,
        clientSecret,
        clientAuth: refresh.clientAuth || "client_secret_basic",
        params: { grant_type: "refresh_token", refresh_token: refreshToken },
      }),
    );
    // A provider may rotate the refresh token on use; keep the newest.
    return { ...record, ...(await oauthTokensOf(response, refresh.kind)) };
  }
  const username = stringField(record, "username", refresh.kind);
  const password = stringField(record, "password", refresh.kind);
  const response = await fetchFn(
    new Request(refresh.graphqlUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // Waitrose's edge answers UA-less requests with HTTP 520 (apps/os, proven live 2026-07-07);
        // the Android app's UA is the known-good request shape.
        "user-agent": "Waitrose/3.9.1 (Android)",
      },
      body: JSON.stringify({
        query: WAITROSE_NEW_SESSION_MUTATION,
        variables: { input: { clientId: "ANDROID_APP", password, username } },
      }),
    }),
  );
  // The live API answers wrong credentials with a 401; the app-client contract is a 200 with a
  // failures[] — read both, name the fix, never echo the credential.
  if (response.status === 401)
    throw new Error(
      "waitrose-session: login refused (HTTP 401) — check the secret's username/password",
    );
  if (!response.ok) throw new Error(`waitrose-session: login answered HTTP ${response.status}`);
  // `{ data: { generateSession: { accessToken, failures } } }` — each level read as a record.
  const data = await jsonRecordOf(response);
  const payload = isRecord(data.data) ? data.data : {};
  const session = isRecord(payload.generateSession) ? payload.generateSession : {};
  const failure =
    Array.isArray(session.failures) && isRecord(session.failures[0])
      ? session.failures[0].type
      : undefined;
  if (typeof failure === "string") throw new Error(`waitrose-session: login refused (${failure})`);
  if (typeof session.accessToken !== "string")
    throw new Error("waitrose-session: login returned no accessToken");
  return { ...record, accessToken: session.accessToken };
}
