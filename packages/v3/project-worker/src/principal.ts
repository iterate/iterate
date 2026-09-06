// principal.ts — WHO is calling, as the platform carries it. A PROJECT TOKEN is a signed claim
// `{ projectId, actor, email?, expiresAt }` minted by whoever fronts the users (the control plane
// after its membership check; a test with the secret) and verified here with the shared secret
// (`APP_CONFIG_PROJECT_TOKEN_SECRET`): `<payload>.<sig>`, payload = base64url(JSON), sig =
// base64url(HMAC-SHA256(payload)) — the control plane's own session-cookie shape. The principal it
// yields rides the session (`authenticate({ projectToken })` → `session.whoami()`), is stamped by the
// DO onto every event that session appends (`source.actor`, unforgeable: the DO owns the field), and
// reaches an app on a project host as the `x-itx-principal` header after the cookie check
// (worker.ts). Identity is ATTRIBUTION, not authority: a session with no token stays the anonymous
// one intra-project code has always held (the trusted-client doctrine).

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
const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64url = (text: string): string =>
  atob(
    text
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(text.length / 4) * 4, "="),
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

/** Mint a project token. */
export async function signProjectToken(
  claims: ProjectTokenClaims,
  secret: string,
): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${base64url(signature)}`;
}

/** The claims of a token that is well-formed, signed with `secret` and not yet expired — else null
 *  (no reason: a caller answers every bad token the same way). A blank secret verifies nothing. */
export async function verifyProjectToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ProjectTokenClaims | null> {
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let signature: Uint8Array;
  let claims: unknown;
  try {
    signature = Uint8Array.from(fromBase64url(token.slice(dot + 1)), (c) => c.charCodeAt(0));
    claims = JSON.parse(fromBase64url(payload));
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature,
    encoder.encode(payload),
  );
  if (!valid || !isProjectTokenClaims(claims) || claims.expiresAt <= now) return null;
  return {
    projectId: claims.projectId,
    actor: claims.actor,
    expiresAt: claims.expiresAt,
    ...(claims.email && { email: claims.email }),
  };
}

const isProjectTokenClaims = (value: unknown): value is ProjectTokenClaims =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProjectTokenClaims).projectId === "string" &&
  typeof (value as ProjectTokenClaims).actor === "string" &&
  typeof (value as ProjectTokenClaims).expiresAt === "number" &&
  (typeof (value as ProjectTokenClaims).email === "string" ||
    (value as ProjectTokenClaims).email === undefined);
