// Verified attribution, the signed-claims codec (the login flow's cookie) and the admin secret's compare.

/** Who is acting: a stable actor id (the control plane's user id) and, when known, an email. */
export type Principal = { actor: string; email?: string };

/** WHO is making a call: the acting principal (null = anonymous). The one thing carried through every
 *  dispatch and every sibling hop (`invoke(call, args, caller)`). Set ONLY by trusted code — the edge
 *  after admission, the kernel — never by a client: the DO's `invoke` is a Workers-RPC verb, never
 *  capnweb-exposed, so a client cannot supply its own `Caller`. Authority is inferred FROM the
 *  principal (no separate scopes/trust field). The path-mask AUTHORITY that reads this to allow/refuse
 *  a path is NOT yet enforced (the control-plane security spec's expected-fails capture what it must do). */
export type Caller = { principal: Principal | null };
/** The header the edge sets on a Request it forwards on a principal's behalf — the ingress after
 *  the cookie check, a session's terminal `fetch` — and strips from every inbound Request. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";

/** The event as the log stores it: `source.principal` is the platform's — set from the session's
 *  verified principal, a client-supplied one dropped (an anonymous session's event carries none). */
export function stampPrincipal<E extends { source?: Record<string, unknown> }>(
  event: E,
  principal: Principal | null,
): E {
  const { principal: _clientSupplied, ...source } = event.source || {};
  if (principal) return { ...event, source: { ...source, principal } };
  return Object.keys(source).length > 0
    ? { ...event, source }
    : (({ source: _dropped, ...rest }) => rest as E)(event);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const bytesFromBase64url = (text: string): Uint8Array<ArrayBuffer> =>
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

/** Sign JSON claims: the bounded Google login flow's cookie (identity.ts). */
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
  let signature: Uint8Array<ArrayBuffer>;
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

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/** Whether two digests are the same bytes — every byte compared, no early exit, so neither a
 *  matching prefix nor its length leaks by timing. */
const digestsEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
};

/** The principal the admin secret grants — `{ actor: "admin" }`, every project — when `candidate`
 *  IS `secret` (`APP_CONFIG_ADMIN_API_SECRET`: at `authenticate({ type: "admin-secret" })`, as a
 *  lane's bearer and on `/mcp`), else null. Both are SHA-256 hashed and the digests compared in
 *  constant time. A blank secret matches nothing. */
export async function verifyAdminSecret(
  candidate: string,
  secret: string,
): Promise<{ actor: "admin" } | null> {
  if (!secret) return null;
  const [candidateDigest, secretDigest] = await Promise.all([sha256(candidate), sha256(secret)]);
  return digestsEqual(candidateDigest, secretDigest) ? { actor: "admin" } : null;
}

/** The value of the cookie `name` in a `Cookie` header, or null. */
export function cookieValueOf(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}
