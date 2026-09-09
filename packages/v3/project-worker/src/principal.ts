// principal.ts — WHO is calling, as the platform carries it. A PROJECT TOKEN is a signed claim
// `{ projectId, actor, email?, expiresAt }` minted by a holder of the secret — `mintToken` on a
// project's handle (iterate-context.ts), the e2e support (e2e/support/principal.ts) — and verified
// here with the shared secret (`APP_CONFIG_PROJECT_TOKEN_SECRET`). The principal it yields rides the
// session (`authenticate({ type: "project-token", token })` → `session.whoami()`), is stamped by the
// DO onto every event that session appends (`source.principal`, unforgeable: the DO owns the field),
// and reaches an app on a project host as the `x-itx-principal` header after the token check (cookie
// or bearer, worker.ts). On an EVENT the principal is ATTRIBUTION; at the SESSION it is also
// authority (session.ts): a project token binds its session to the token's one project, a
// control-plane user's session admits the projects of their orgs, the ADMIN SECRET
// (`verifyAdminSecret`, `APP_CONFIG_ADMIN_API_SECRET`) is `{ actor: "admin" }` on every project, and
// a PROJECT SECRET — the project's own long-lived key (`rotateProjectApiKey` mints it, only its hash
// is kept; `verifyProjectSecret` checks a candidate) — is `{ actor: "project:<projectId>" }` on that
// one project: a device, a headless app, speaking AS the project.
//
// `signClaims` / `verifyClaims` is THE ONE signed-claims codec — `<payload>.<sig>`, payload =
// base64url(UTF-8 JSON), sig = base64url(HMAC-SHA256(payload)) — the control plane's session cookie
// (control-plane.ts) is the same codec under its own secret.

/** Who is acting: a stable actor id (the control plane's user id) and, when known, an email. */
export type Principal = { actor: string; email?: string };
/** The header the edge sets on a Request it forwards on a principal's behalf — the ingress after
 *  the cookie check, a session's terminal `fetch` — and strips from every inbound Request. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";

/** The event as the log stores it: `source.principal` is the platform's — set from the session's
 *  verified principal, a client-supplied one dropped (an anonymous session's event carries none). */
export function stampPrincipal<E extends { source?: Record<string, unknown> }>(
  event: E,
  principal: Principal | null,
): E {
  const { principal: _clientSupplied, ...source } = event.source ?? {};
  if (principal) return { ...event, source: { ...source, principal } };
  return Object.keys(source).length > 0
    ? { ...event, source }
    : (({ source: _dropped, ...rest }) => rest as E)(event);
}
/** The claims a project token carries: the principal, for ONE project, until `expiresAt` (ms). */
export type ProjectTokenClaims = Principal & { projectId: string; expiresAt: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const bytesFromBase64url = (text: string): Uint8Array =>
  Uint8Array.from(
    atob(
      text
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(text.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Sign any JSON claims with `secret` — a project token's `ProjectTokenClaims` (e2e/support/principal.ts
 *  mints them), the control plane's session (control-plane.ts). */
export async function signClaims(claims: unknown, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The claims of a token that is well-formed and signed with `secret` — else null (no reason: a
 *  caller answers every bad token the same way). A blank secret verifies nothing. The caller checks
 *  the claims' SHAPE and expiry. */
export async function verifyClaims(token: string, secret: string): Promise<unknown> {
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let signature: Uint8Array;
  let claims: unknown;
  try {
    signature = bytesFromBase64url(token.slice(dot + 1));
    claims = JSON.parse(decoder.decode(bytesFromBase64url(payload)));
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature,
    encoder.encode(payload),
  );
  return valid ? claims : null;
}

/** The claims of a project token that verifies (`verifyClaims`), has the claims' shape and is not
 *  yet expired — else null. */
export async function verifyProjectToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ProjectTokenClaims | null> {
  const claims = await verifyClaims(token, secret);
  if (!isProjectTokenClaims(claims) || claims.expiresAt <= now) return null;
  return {
    projectId: claims.projectId,
    actor: claims.actor,
    expiresAt: claims.expiresAt,
    ...(claims.email && { email: claims.email }),
  };
}

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/** Whether two digests are the same bytes — every byte compared, no early exit, so neither a
 *  matching prefix nor its length leaks by timing (both secret checks below go through here). */
const digestsEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
};

/** Whether `candidate` IS `secret` — the admin secret's check (`APP_CONFIG_ADMIN_API_SECRET`: at
 *  `authenticate({ type: "admin-secret" })` and as a lane's bearer, worker.ts). Both are SHA-256
 *  hashed and the digests compared in constant time. A blank secret matches nothing. */
export async function verifyAdminSecret(candidate: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const [a, b] = await Promise.all([sha256(candidate), sha256(secret)]);
  return digestsEqual(a, b);
}

// ── the project secret ── the project's own long-lived key, kept as a HASH in SECRETS_KV.

/** The SECRETS_KV key a project's API-key hash sits under — OUTSIDE the `secret:<projectId>:` prefix
 *  egress substitutes from (iterate-context-durable-object.ts `#egress`, context/built-ins.ts
 *  `secretKey`): no `{{secret:project:NAME}}` placeholder can spell it, so the key that
 *  authenticates AS the project can never be substituted into an outbound request by the project's
 *  own code. */
const projectApiKeyHashKey = (projectId: string): string => `project-api-key:${projectId}`;

/** Mint `projectId`'s API key — 32 random bytes as base64url — and store its SHA-256 hash under
 *  `project-api-key:<projectId>`, REPLACING the previous one: the previous key stops verifying at
 *  once where the rotation was made (KV's other locations follow within 60 s, its cache TTL). The
 *  key itself is returned ONCE and never stored, so a "reveal" IS a rotation
 *  (`IterateContext.rotateApiKey`). A project has no key until its first rotation. */
export async function rotateProjectApiKey(
  projectId: string,
  secretsKv: KVNamespace,
): Promise<string> {
  const apiKey = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await secretsKv.put(projectApiKeyHashKey(projectId), base64url(await sha256(apiKey)));
  return apiKey;
}

/** The principal a project secret grants — `{ actor: "project:<project>" }`, for exactly `project`
 *  — when `secret`'s SHA-256 is the hash stored for it (`rotateProjectApiKey`); else null, whatever
 *  is wrong: no key stored (never rotated, or no such project), a wrong or superseded key, another
 *  project's key. The digests are compared in constant time. At `authenticate({ type:
 *  "project-secret" })` (session.ts) and as a lane's bearer for the lane's own project (worker.ts). */
export async function verifyProjectSecret(
  project: string,
  secret: string,
  secretsKv: KVNamespace,
): Promise<Principal | null> {
  const storedHash = await secretsKv.get(projectApiKeyHashKey(project));
  if (!storedHash) return null;
  let storedDigest: Uint8Array;
  try {
    storedDigest = bytesFromBase64url(storedHash);
  } catch {
    return null;
  }
  return digestsEqual(await sha256(secret), storedDigest) ? { actor: `project:${project}` } : null;
}

const isProjectTokenClaims = (value: unknown): value is ProjectTokenClaims =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProjectTokenClaims).projectId === "string" &&
  typeof (value as ProjectTokenClaims).actor === "string" &&
  typeof (value as ProjectTokenClaims).expiresAt === "number" &&
  (typeof (value as ProjectTokenClaims).email === "string" ||
    (value as ProjectTokenClaims).email === undefined);
