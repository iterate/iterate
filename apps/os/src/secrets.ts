// secrets.ts — a project secret, the pure half: what a secret IS (material + a URL pin + an optional
// refresh strategy), the placeholder grammar egress substitutes, and the refresh strategies that
// need no platform credential, each a plain function of (strategy, material, fetch). No Cloudflare import — the node unit tests
// cover every row — and only erasable TypeScript syntax, so a type-stripping loader can take it. The
// host that keeps a record and runs these is the secret facet (secret/durable-object.ts); the verbs
// that write one are `itx.secrets` (context/built-ins.ts).
//
// The invariant:
// material goes in; nothing comes out except a request to a pinned host. Refresh runs INSIDE the
// secret's own facet — a named strategy in trusted code whose exchange endpoint must itself be
// pinned, or the secret's own exchange code in a jail whose only egress is the pin
// (secret/exchange-jail.ts) — so a credential that expires (an OAuth access token, a Waitrose or
// Tesco session) is one secret, not a worker.

// The shapes a caller sees — the material, the client-auth method and the refresh strategy — are the
// SDK's (`iterate/api`, where the dash and every client read them).
import type {
  ClientAuth,
  SecretHmacVerification,
  SecretMaterial,
  SecretRefresh,
} from "iterate/api";
import { secretsEqual, signClaims, verifyClaims } from "./caller.ts";
import { exchange as exchangeWaitroseSession } from "./integrations/waitrose.ts";
import { basicAuthorization } from "./repo/git-wire.ts";
import { SecretRefreshKind } from "./secret/contract.ts";

/** What the secret's facet stores: the material, the ORIGINS it may be sent to (never
 *  empty — a secret is always pinned), and the refresh strategy or none. */
export type SecretRecord = {
  material: SecretMaterial;
  urls: string[];
  refresh: SecretRefresh | null;
};

/** The most exchange code (`refresh: { kind: "worker", source }`) may be: it is sealed in the
 *  secret's record beside the material, and a login is a few requests, not a bundle. */
export const EXCHANGE_SOURCE_MAX_CHARS = 64 * 1024;

/** The deployment's apps an `oauth-refresh-token` strategy may name as its client (`{ platform }`):
 *  each refreshes with that app's credentials, attached in the secret's facet. GitHub's is the App's
 *  user-authorization client, which a GitHub sign-in's token refreshes with. */
const OAUTH_REFRESH_PLATFORMS = ["slack", "google", "cloudflare", "github"] as const;

/** A secret's name: `[a-zA-Z0-9._-]+`, but never `.` or `..` — the two segments
 *  `resolveContextPath` resolves away, so `/secrets/..` would name its owner's ROOT (and
 *  `/secrets/.` the `/secrets` context), never a secret's own context. The stored path and the
 *  placeholder share this grammar. */
const SECRET_NAME = String.raw`(?!\.\.?(?![a-zA-Z0-9._-]))[a-zA-Z0-9._-]+`;

/** A secret IS its path, and the path is what the placeholder spells: `/secrets/<name>` — under the
 *  resource owner's root (a user's own secret lives at `/users/<id>/secrets/<name>`; the
 *  placeholder still spells `/secrets/<name>`). */
export const SECRET_PATH = new RegExp(`^/secrets/${SECRET_NAME}$`);

export function assertSecretPath(path: string): string {
  if (!SECRET_PATH.test(path))
    throw new Error(
      `secrets: a secret's path is /secrets/<name>, the name [a-zA-Z0-9._-]+ and never "." or ".." (what getSecret("/secrets/<name>") can spell), got ${JSON.stringify(path)}`,
    );
  return path;
}

/** A plain JSON object — not an array, which `typeof` also calls an object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && !!value && !Array.isArray(value);
}

const CLIENT_AUTHS: readonly ClientAuth[] = ["client_secret_basic", "client_secret_post", "none"];

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
    // The one place a strategy kind (`SecretRefreshKind`, secret/contract.ts) is admitted from
    // untyped input.
    const parsedKind = isRecord(options.refresh)
      ? SecretRefreshKind.safeParse(options.refresh.kind)
      : undefined;
    if (!isRecord(options.refresh) || !parsedKind?.success)
      throw new Error(
        `secrets: refresh.kind is one of ${SecretRefreshKind.options.join(", ")}, got ${JSON.stringify(isRecord(options.refresh) ? options.refresh.kind : options.refresh)}`,
      );
    const kind = parsedKind.data;
    const strategy = options.refresh;
    if (kind === "worker") {
      const { source } = strategy;
      if (typeof source !== "string" || !/\bexchange\b/.test(source))
        throw new Error(
          "secrets: refresh.source is an ES module exporting `async function exchange(material, fetch)`",
        );
      if (source.length > EXCHANGE_SOURCE_MAX_CHARS)
        throw new Error(
          `secrets: refresh.source is ${source.length} chars, over the ${EXCHANGE_SOURCE_MAX_CHARS}-char ceiling`,
        );
      return { material, urls, refresh: { kind, source } };
    }
    const endpointKey =
      kind === "oauth-refresh-token"
        ? "tokenEndpoint"
        : kind === "waitrose-session"
          ? "graphqlUrl"
          : "apiOrigin";
    const endpoint = new URL(String(strategy[endpointKey]));
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
      throw new Error(`secrets: refresh.${endpointKey} must be an http(s) URL`);
    if (!urls.includes(endpoint.origin))
      throw new Error(
        `secrets: refresh.${endpointKey} ${endpoint.origin} is outside the pin ${urls.join(", ")} — a refresh only ever sends the material toward a pinned host`,
      );
    const client = isRecord(strategy.client) ? strategy.client : undefined;
    if (kind === "oauth-refresh-token") {
      const platform = OAUTH_REFRESH_PLATFORMS.find((name) => name === client?.platform);
      if (client && !platform)
        throw new Error(
          `secrets: refresh.client is { platform: ${OAUTH_REFRESH_PLATFORMS.map((name) => JSON.stringify(name)).join(" | ")} }`,
        );
      refresh = {
        kind,
        tokenEndpoint: endpoint.href,
        clientAuth: clientAuthOf(strategy.clientAuth),
        ...(platform && { client: { platform } }),
      };
    } else if (kind === "waitrose-session") refresh = { kind, graphqlUrl: endpoint.href };
    else {
      const installationId = String(strategy.installationId ?? "");
      // it lands in a URL path: GitHub's ids are digits, a fake's a slug
      if (!/^[a-zA-Z0-9_-]+$/.test(installationId))
        throw new Error("secrets: refresh.installationId is GitHub's id ([a-zA-Z0-9_-]+)");
      if (client?.platform !== "github" && client?.project !== "github")
        throw new Error(
          'secrets: refresh.client is { platform: "github" } or { project: "github" }',
        );
      refresh = {
        kind,
        apiOrigin: endpoint.origin,
        installationId,
        client: client.platform === "github" ? { platform: "github" } : { project: "github" },
      };
    }
  }
  return { material, urls, refresh };
}

// ── the placeholder grammar ── for a URL or a header:
// `getSecret("/secrets/NAME")` is the whole stored value; `getSecret("/secrets/NAME", { field: "a.b" })`
// is one dotted field of a JSON-valued secret. Double quotes, whitespace free inside the
// parentheses; `/secrets/NAME` is the PATH `itx.secrets.set("/secrets/NAME", …)` stored. Matched as written in a
// header, and as the URL parser percent-encodes it in a URL (`"` → %22, a space → %20, `{` → %7B, `}`
// → %7D) — the path and the query alike; the value is spliced back into the URL as ONE component,
// `:` kept (Telegram's `bot123:abc` path). A `Basic base64(user:getSecret(…))` credential is peeled:
// the placeholder is substituted inside the decoded `user:password` and the credential encoded
// again — the Authorization a git remote's userinfo becomes (`https://x:getSecret(…)@host/repo.git`,
// as git and curl send it). No JSON-body template — the body is never scanned.
const QUOTE = '(?:"|%22)';
const SPACE = "(?:\\s|%20)*";
const SECRET_PLACEHOLDER = new RegExp(
  `getSecret\\(${SPACE}${QUOTE}(/secrets/${SECRET_NAME})${QUOTE}${SPACE}` +
    `(?:,${SPACE}(?:\\{|%7B)${SPACE}field${SPACE}:${SPACE}${QUOTE}([^"%\\s]+)${QUOTE}${SPACE}(?:\\}|%7D))?${SPACE}\\)`,
  "g",
);

/** Whether `value` is exactly one placeholder (`getSecret("/secrets/x")`, or with a field) and
 *  nothing else: what a git origin's password may be, so an origin never holds a token. */
export function isSecretPlaceholder(value: string): boolean {
  const [match] = [...value.matchAll(SECRET_PLACEHOLDER)];
  return match?.index === 0 && match[0].length === value.length;
}

/** The placeholder as a caller wrote it, for a refusal that names it. */
const placeholderOf = (path: string, field: string | undefined): string =>
  !field ? `getSecret("${path}")` : `getSecret("${path}", { field: "${field}" })`;

/** A placeholder the secret cannot honour — no secret stored, a `field` the material has no string
 *  at, a secret pinned to other origins — answered with a 502 to the CALLER, never the destination.
 *  `mintable` marks the two misses a refresh strategy can fill (no material yet, a field not there
 *  yet): the mint-on-first-use. */
export class SecretRefused extends Error {
  readonly mintable: boolean;
  // A plain field, not a parameter property: only erasable syntax in this module (the header).
  constructor(message: string, mintable = false) {
    super(message);
    this.mintable = mintable;
  }
}

/** The string `field` (a dotted path) selects in `material`; refused when the material is one
 *  string (it has no fields) or the path does not land on a string. */
function secretFieldOf(
  material: SecretMaterial,
  field: string,
  placeholder: string,
  where: string,
): string {
  if (typeof material === "string")
    throw new SecretRefused(
      `itx.fetch: ${placeholder} in ${where} names a field, but the secret is one string, not an object`,
    );
  let value: unknown = material;
  for (const segment of field.split(".")) value = isRecord(value) ? value[segment] : undefined;
  if (typeof value !== "string")
    throw new SecretRefused(
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
  for (const [, value] of request.headers) scan(basicCredentialOf(value) ?? value);
  return [...paths];
}

/** The decoded `user:password` of a `Basic` header value, or null when the value is no Basic
 *  credential (or not base64 of UTF-8). */
function basicCredentialOf(value: string): string | null {
  const encoded = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value)?.[1];
  if (!encoded) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

// ── a WebSocket's frames ── the Discord shape: the upgrade carries no credential, the first client
// frame does (IDENTIFY `{"op":2,"d":{"token":…}}`). An upgrade that asks for it names its secret in
// `SECRET_FRAMES_HEADER` (which also routes it through egress to that secret), and the secret's facet
// then terminates the caller's socket, dials the upstream itself and substitutes the placeholder in
// every client→server TEXT frame (secret/durable-object.ts `#proxyFrames`).

/** The upgrade header naming the secret whose placeholders the client's frames may spell:
 *  `x-itx-secret-frames: getSecret("/secrets/discord")`. Never sent upstream. */
export const SECRET_FRAMES_HEADER = "x-itx-secret-frames";

/** The placeholder as it sits in a frame: as written, or inside a JSON string (`\"` quotes) —
 *  a JSON frame's `"token": "getSecret(\"/secrets/x\")"`. */
const FRAME_PLACEHOLDER = new RegExp(
  String.raw`getSecret\(\s*(\\?)"(/secrets/${SECRET_NAME})\\?"\s*(?:,\s*\{\s*field\s*:\s*\\?"([^"\\\s]+)\\?"\s*\})?\s*\)`,
  "g",
);

/** One client→server text frame with every placeholder of `path` (or `alias`, a lend's borrowed
 *  path) substituted by the material — JSON-escaped where the placeholder sat inside a JSON string.
 *  A placeholder naming any other secret is refused (`SecretRefused`): one socket, one secret. */
export function substituteSecretInFrame(
  frame: string,
  paths: string[],
  material: SecretMaterial,
): string {
  if (!frame.includes("getSecret(")) return frame;
  return frame.replaceAll(FRAME_PLACEHOLDER, (_match, escaped: string, path: string, field) => {
    const placeholder = placeholderOf(path, field);
    if (!paths.includes(path))
      throw new SecretRefused(`itx.fetch: ${placeholder} in a frame names another secret`);
    const where = "a WebSocket frame";
    let secret: string;
    if (field) secret = secretFieldOf(material, field, placeholder, where);
    else if (typeof material === "string") secret = material;
    else
      throw new SecretRefused(
        `itx.fetch: ${placeholder} in ${where} names no field, but the secret is a JSON object`,
      );
    return escaped ? JSON.stringify(secret).slice(1, -1) : secret;
  });
}

/** The secret paths one string's placeholders name. */
export function secretPathsIn(value: string): string[] {
  if (!value.includes("getSecret(")) return [];
  return [...new Set([...value.matchAll(SECRET_PLACEHOLDER)].map(([, path = ""]) => path))];
}

// ── a lend's use on the fetch channel ── a borrowed path's use reaches the lender over `fetch`
// (a 101's socket crosses no Workers-RPC method call — DataCloneError): the borrower's facet signs
// the lend it holds into `LEND_USE_HEADER` for the lender's context, which admits it and hands the
// request to its facet with the path it is lent as in `LENT_AS_HEADER`. Both sit under `x-itx-lend`,
// which every egress strips — no caller's header ever reaches either hop.

/** The borrower facet → the lender's context: the lend, signed with the deployment's key. */
export const LEND_USE_HEADER = "x-itx-lend-use";
/** The lender's context → its own facet, after admission: `{ as, borrower }` JSON. */
export const LENT_AS_HEADER = "x-itx-lend-as";

type LendUse = { kind: "lend-use"; lender: string; lendId: string; borrower: string; exp: number };

export const signLendUse = (
  lend: { lender: string; lendId: string; borrower: string },
  key: string,
): Promise<string> =>
  signClaims({ kind: "lend-use", ...lend, exp: Date.now() + 60_000 } satisfies LendUse, key);

/** The lend a `LEND_USE_HEADER` names, for the context `lender` — or null (forged, expired,
 *  another lender's). */
export async function verifyLendUse(
  token: string,
  key: string,
  lender: string,
): Promise<{ lendId: string; borrower: string } | null> {
  // Signed by the deployment's key, so the shape is the platform's own (`signLendUse`).
  const claims = (await verifyClaims(token, key)) as Partial<LendUse> | null;
  if (
    claims?.kind !== "lend-use" ||
    claims.lender !== lender ||
    !claims.lendId ||
    !claims.borrower ||
    !(claims.exp! >= Date.now())
  )
    return null;
  return { lendId: claims.lendId, borrower: claims.borrower };
}

/**
 * Substitute every `getSecret("/secrets/<name>")` placeholder in the request URL AND headers. An
 * existing secret must never survive as a literal placeholder wherever it appears (a URL
 * `?access_token=getSecret("/secrets/token")` would otherwise send the credential's NAME to the
 * destination and the value nowhere); a placeholder with NO stored secret throws
 * `SecretRefused` naming the placeholder and where it sat — to the caller, never the
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
        throw new SecretRefused(
          `itx.fetch: no stored project secret for ${placeholder} in ${where}`,
          true,
        );
      let secret: string;
      if (field) secret = secretFieldOf(stored, field, placeholder, where);
      else if (typeof stored === "string") secret = stored;
      else
        throw new SecretRefused(
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
    const credential = basicCredentialOf(value);
    const inCredential = credential
      ? await substitute(credential, `header "${name}"`, false)
      : null;
    const substituted = inCredential
      ? basicAuthorization(inCredential)
      : await substitute(value, `header "${name}"`, false);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- substitute() returns null for "no placeholder here"; a substituted-to-empty header ("") is a real change and must be written, not skipped
    if (substituted !== null) {
      headers.set(name, substituted);
      changed = true;
    }
  }
  return changed ? new Request(base, { headers }) : base;
}

/** The material as an HMAC key: the whole value when it is a string and no field is named, else the
 *  string at `field` of an object material. Anything else — an object with no field named, a field
 *  on a string, a field with no string at it — is null: no key, so nothing verifies. */
export function secretMaterialStringOf(material: SecretMaterial, field?: string): string | null {
  if (!field) return typeof material === "string" ? material : null;
  let value: unknown = material;
  for (const segment of field.split(".")) value = isRecord(value) ? value[segment] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** SHA-256 of a string, hex: exchange code's identity (the catalog's `refreshSourceSha256`). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hex HMAC-SHA256 of `payload` under `key`. WebCrypto, present in every isolate. */
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

/** THE VERIFY OPERATION, pure: does `signature` (hex, either case) equal the HMAC-SHA256 of `payload`
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
  return secretsEqual(await hmacSha256Hex(key, input.payload), signature);
}

/** A secret is sent to its pinned origins ONLY — a mis-typed URL cannot mail a credential to a
 *  stranger, and an app that forwards a visitor's headers cannot be made to mail it either. */
export function originPinned(url: string, urls: string[]): boolean {
  return urls.includes(new URL(url).origin);
}

export function pinRefusal(path: string, url: string, urls: string[]): SecretRefused {
  return new SecretRefused(
    `itx.fetch: the secret ${path} is pinned to ${urls.join(", ")} — not sent to ${new URL(url).origin}`,
  );
}

// ── the refresh strategies ── each a pure function of (strategy, material, fetch): read the
// material, POST within the pin, return the NEXT material. The host (secret/durable-object.ts) runs
// ONE at a time per secret and stores the answer. A credential never appears in an error message.

/** The material as a record — a string has no fields. */
function materialRecordOf(material: SecretMaterial | null): Record<string, unknown> {
  return typeof material === "object" && material ? material : {};
}

function stringField(record: Record<string, unknown>, field: string, kind: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "")
    throw new Error(`${kind}: the secret's material has no "${field}"`);
  return value;
}

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
  // The deployment's client and a GitHub App's key are attached by the facet itself
  // (secret/durable-object.ts), never read from material here.
  if (
    refresh.kind === "github-app-installation" ||
    (refresh.kind === "oauth-refresh-token" && refresh.client)
  )
    throw new Error(`${refresh.kind}: the secret's facet attaches this credential itself`);
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
  // Waitrose's login is bundled exchange code of the same shape as a secret's own.
  if (refresh.kind === "waitrose-session")
    return exchangeWaitroseSession(material, fetchFn, { graphqlUrl: refresh.graphqlUrl });
  throw new Error(`${refresh.kind}: the secret's facet runs this exchange code in its jail`);
}
