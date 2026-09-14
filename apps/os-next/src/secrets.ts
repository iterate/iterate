// secrets.ts — THE SECRET CELL, its pure half: what a project secret IS (material + a URL pin + an
// optional refresh strategy), the placeholder grammar egress substitutes, and the two refresh
// strategies, each a plain function of (strategy, material, fetch). No Cloudflare import — the node
// unit tests cover every row. The host that keeps a record and runs these is secret-durable-object.ts.
//
// apps/os's cell invariant (apps/os/docs/adr/0005-the-secret-cell-invariant.md), carried over whole:
// material goes in; nothing comes out except a request to a pinned host. Refresh runs INSIDE the
// cell — a named strategy in trusted code whose exchange endpoint must itself be pinned — so a
// credential that expires (an OAuth access token, a Waitrose session) is one secret, not a worker.

/** A secret's material: one string (`getSecret("/secrets/NAME")` is the whole value) or a JSON
 *  object whose string fields `getSecret("/secrets/NAME", { field: "a.b" })` picks — the
 *  multidimensional shape a credential exchange needs (`{ username, password, accessToken }`,
 *  `{ clientId, clientSecret, refreshToken, accessToken }`). A JSON STRING still works as an object
 *  (`set(name, JSON.stringify({...}))`). */
export type SecretMaterial = string | Record<string, unknown>;

/** How the cell re-mints an expired credential, in its own trusted code: the exchange reads this
 *  secret's own material, POSTs to an endpoint within the pin, and writes the answer back into the
 *  material — `accessToken` (and a rotated `refreshToken`). Triggered on a 401 from the pinned
 *  host, and on first use when the placeholder's field is not there yet (the mint-on-first-use). */
export type SecretRefresh =
  /** RFC 6749 §6, the refresh_token grant: `refreshToken` + `clientId` (+ `clientSecret` for a
   *  confidential client, HTTP Basic; a public client sends `client_id` in the body) from the
   *  material → `accessToken` (+ the newest `refreshToken`). Google, GitHub OAuth apps, an MCP
   *  server's authorization server, the petshop fixture. */
  | { kind: "oauth-refresh-token"; tokenEndpoint: string }
  /** The username/password → session-token archetype, Waitrose's login: POST the app's `NewSession`
   *  GraphQL mutation with `username`/`password` from the material → `accessToken`. Waitrose has no
   *  refresh grant — re-login IS the refresh — so one strategy covers the first-use mint and the
   *  401 re-mint. */
  | { kind: "waitrose-session"; graphqlUrl: string };

/** What the cell stores: the material, the ORIGINS it may be sent to (empty = unbound: the value
 *  goes wherever the caller aims), and the refresh strategy or none. */
export type SecretRecord = {
  material: SecretMaterial;
  urls: string[];
  refresh: SecretRefresh | null;
};

/** A secret's catalog entry — `itx.secrets.list()` — the name, the pin and the strategy's KIND;
 *  never a value (what `events.iterate.com/secrets/changed` carries, reduced by the core). */
export type SecretCatalogEntry = { name: string; urls?: string[]; refresh?: SecretRefresh["kind"] };

/** A name is what the placeholder can spell. */
export const SECRET_NAME = /^[a-zA-Z0-9._-]+$/;

export function assertSecretName(name: string): string {
  if (!SECRET_NAME.test(name))
    throw new Error(
      `secrets: a name is [a-zA-Z0-9._-]+ (what getSecret("/secrets/NAME") can spell), got ${JSON.stringify(name)}`,
    );
  return name;
}

/** A plain JSON object, as `typeof` sees it (an array is one too; a field read on it is undefined). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && !!value;
}

const REFRESH_KINDS: readonly SecretRefresh["kind"][] = ["oauth-refresh-token", "waitrose-session"];

/** The strategy kinds the cell implements — the one place a kind is admitted from untyped input
 *  (a `set` option, a `secrets/changed` payload). */
export function isRefreshKind(kind: unknown): kind is SecretRefresh["kind"] {
  return REFRESH_KINDS.some((known) => known === kind);
}

/** The URL a strategy exchanges at. */
export function refreshEndpointOf(refresh: SecretRefresh): string {
  return refresh.kind === "oauth-refresh-token" ? refresh.tokenEndpoint : refresh.graphqlUrl;
}

/** The record as `itx.secrets.set(name, material, { urls?, refresh? })` spells it, validated and
 *  normalized: a URL pin is a list of ORIGINS (a path or query on one is dropped), the strategy is
 *  one of the named kinds with an http(s) endpoint that falls within the pin when there is one. */
export function normalizeSecretRecord(
  material: unknown,
  options: { urls?: unknown; refresh?: unknown } | undefined,
): SecretRecord {
  if (typeof material !== "string" && !isRecord(material))
    throw new Error("secrets: material is a string or a JSON object");
  let urls: string[] = [];
  if (options?.urls !== undefined) {
    if (!Array.isArray(options.urls)) throw new Error("secrets: urls is a list of URLs");
    urls = [...new Set(options.urls.map((url) => new URL(String(url)).origin))];
  }
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
    if (urls.length > 0 && !urls.includes(endpoint.origin))
      throw new Error(
        `secrets: refresh.${endpointKey} ${endpoint.origin} is outside the pin ${urls.join(", ")} — a refresh only ever sends the material toward a pinned host`,
      );
    refresh =
      kind === "oauth-refresh-token"
        ? { kind, tokenEndpoint: endpoint.href }
        : { kind, graphqlUrl: endpoint.href };
  }
  return { material, urls, refresh };
}

// ── the placeholder grammar ── apps/os's (apps/os/src/domains/secrets/utils.ts) for a URL or a header:
// `getSecret("/secrets/NAME")` is the whole stored value; `getSecret("/secrets/NAME", { field: "a.b" })`
// is one dotted field of a JSON-valued secret. Double quotes, whitespace free inside the
// parentheses; `/secrets/NAME` is the name `itx.secrets.set(NAME, …)` stored. Matched as written in a
// header, and as the URL parser percent-encodes it in a URL (`"` → %22, a space → %20, `{` → %7B, `}`
// → %7D) — the path and the query alike; the value is spliced back into the URL as ONE component,
// `:` kept (Telegram's `bot123:abc` path). Where this DIVERGES from apps/os: no peeling of a `Basic
// base64(user:getSecret(…))` credential, no JSON-body template — the body is never scanned.
const QUOTE = '(?:"|%22)';
const SPACE = "(?:\\s|%20)*";
const SECRET_PLACEHOLDER = new RegExp(
  `getSecret\\(${SPACE}${QUOTE}/secrets/([a-zA-Z0-9._-]+)${QUOTE}${SPACE}` +
    `(?:,${SPACE}(?:\\{|%7B)${SPACE}field${SPACE}:${SPACE}${QUOTE}([^"%\\s]+)${QUOTE}${SPACE}(?:\\}|%7D))?${SPACE}\\)`,
  "g",
);

/** The placeholder as a caller wrote it, for a refusal that names it. */
const placeholderOf = (name: string, field: string | undefined): string =>
  !field ? `getSecret("/secrets/${name}")` : `getSecret("/secrets/${name}", { field: "${field}" })`;

/** A placeholder the cell cannot honour — no secret stored, a `field` the material has no string
 *  at, a secret pinned to other origins — answered with a 502 to the CALLER, never the destination.
 *  `mintable` marks the two misses a refresh strategy can fill (no material yet, a field not there
 *  yet): the mint-on-first-use. */
export class ProjectSecretRefused extends Error {
  readonly mintable: boolean;
  // A plain field, not a parameter property: this module is loaded by Node's type-stripping child in
  // memory-budget.test.ts (through the core reduce's `isRefreshKind`), which only erases annotations.
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

/** The DISTINCT secret names a request's URL and headers reference — how egress knows which cell a
 *  request belongs to (one request, one secret). */
export function secretNamesReferenced(request: Request): string[] {
  const names = new Set<string>();
  const scan = (value: string) => {
    if (!value.includes("getSecret(")) return;
    for (const [, name = ""] of value.matchAll(SECRET_PLACEHOLDER)) names.add(name);
  };
  scan(request.url);
  for (const [, value] of request.headers) scan(value);
  return [...names];
}

/**
 * Substitute every `getSecret("/secrets/<name>")` placeholder in the request URL AND headers. An
 * existing secret must never survive as a literal placeholder wherever it appears (a URL
 * `?access_token=getSecret("/secrets/token")` would otherwise send the credential's NAME to the
 * destination and the value nowhere); a placeholder with NO stored secret throws
 * `ProjectSecretRefused` naming the placeholder and where it sat — to the caller, never the
 * destination. `resolve(name)` answers the stored material; a `{ field }` placeholder then picks one
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
  resolve: (name: string) => Promise<SecretMaterial | null> | SecretMaterial | null,
): Promise<Request> {
  // Substitute the placeholders in one string; null = none in it (leave as-is).
  const substitute = async (value: string, where: string, encode: boolean) => {
    if (!value.includes("getSecret(")) return null;
    let out = "";
    let last = 0;
    let any = false;
    for (const m of value.matchAll(SECRET_PLACEHOLDER)) {
      // The two capture groups: the name (always present on a match), the optional field.
      const [, name = "", field] = m;
      const placeholder = placeholderOf(name, field);
      const stored = await resolve(name);
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

/** A secret with a pin is sent to those origins ONLY — a mis-typed URL cannot mail a credential to
 *  a stranger. An empty pin binds nothing. */
export function originPinned(url: string, urls: string[]): boolean {
  return urls.length === 0 || urls.includes(new URL(url).origin);
}

export function pinRefusal(name: string, url: string, urls: string[]): ProjectSecretRefused {
  return new ProjectSecretRefused(
    `itx.fetch: project secret ${name} is bound to ${urls.join(", ")} — not sent to ${new URL(url).origin}`,
  );
}

// ── the refresh strategies ── each a pure function of (strategy, material, fetch): read the
// material, POST within the pin, return the NEXT material. The host (secret-durable-object.ts) runs
// ONE at a time per secret and stores the answer. A credential never appears in an error message.

/** The material as a record — a JSON string parses, a plain string has no fields. */
export function materialRecordOf(material: SecretMaterial | null): Record<string, unknown> {
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
export const WAITROSE_NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";

/** A provider's JSON answer, read as a record — anything else (not JSON, a bare value) is `{}`, so
 *  every field read below falls through to the "returned no …" refusal. */
async function jsonRecordOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) ? body : {};
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
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    // A confidential client authenticates with HTTP Basic; a public client (no secret) identifies
    // itself with client_id in the body (RFC 6749 §6).
    if (!clientSecret) body.set("client_id", clientId);
    const response = await fetchFn(
      new Request(refresh.tokenEndpoint, {
        method: "POST",
        headers: {
          ...(clientSecret && {
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          }),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      }),
    );
    if (!response.ok)
      throw new Error(`oauth-refresh-token: the token endpoint answered ${response.status}`);
    const data = await jsonRecordOf(response);
    if (typeof data.access_token !== "string")
      throw new Error("oauth-refresh-token: the token endpoint returned no access_token");
    return {
      ...record,
      accessToken: data.access_token,
      // A provider may rotate the refresh token on use; keep the newest.
      ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
    };
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
