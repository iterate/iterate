// caller.ts — how the platform attributes a call: the `Caller` the edge admits and carries through
// every dispatch, the headers it forwards a caller in, `stampCaller` (the attribution an event is
// stored with), and the token crypto, WebCrypto only: the signed-claims codec, `sha256Hex` and
// `secretsEqual`. Only this worker sets or reads any of it; what user code sees of a caller is the
// SDK's `Principal` and `ITX_PRINCIPAL_HEADER` (iterate/principal).
import type { Principal } from "iterate/principal";
import type { EventSource } from "iterate/stream/processor";

/** WHO is making a call: the acting principal (null = anonymous). The one thing carried through every
 *  dispatch and every sibling hop (`invoke(call, args, caller)`). Set ONLY by trusted code — the edge
 *  after admission, the kernel — never by a client: the DO's `invoke` is a Workers-RPC verb, never
 *  capnweb-exposed, so a client cannot supply its own `Caller`. Authority is inferred FROM the
 *  principal (no separate scopes/trust field). Global contexts remain non-navigable through
 *  `cd`, including calls without a principal. */
export type Caller = {
  principal: Principal | null;
  /** THE CONNECTION the principal acts through: the OAuth grant's id — one per connected
   *  client (a Claude Code install, a dash sign-in, a personal token), the same across every call it
   *  makes. Absent for the admin secret and the kernel. */
  grant?: string;
  /** The context the call ORIGINATED at — stamped by the first `cd` hop and forwarded by every later
   *  one, so a relative path resolved after a hop (`repos.get('./x')` answered at the root) still
   *  means the caller's `./x`. Absent until a hop. Its presence also means the complete input
   *  expression was already admitted: a receiving resolver must not recheck owner-written
   *  rewrites as loaded code's input. Fresh env.ITX calls never inherit this stamp. */
  path?: string;
  /** Set when the caller is LOADED CODE — a worker, a facet, a script — holding a context through
   *  `env.ITX`. Under it the resolver refuses the fixed point (`itx.builtins…`) and any `cd` above
   *  the caller's own context on the INPUT expression; rewrites the owner wrote are never subject. */
  app?: true;
  /** THE PLATFORM ORIGIN the caller reached the platform on — what a public URL is composed from
   *  (`itx.url`, a signed file URL). Absent for a caller with none (a loaded worker's `env.ITX`, the
   *  kernel); the context then uses the last one it was reached on. */
  platformOrigin?: string | null;
  /** Set ONLY by the platform's own code, on the one `itx.builtins.append` of a fact it vouches for
   *  on the principal's behalf — an account's or an organization's (apps/os session.ts
   *  `appendPlatformFacts`, the secrets built-ins' catalog cross-post) — never by a client, who never
   *  supplies a Caller. `stampCaller` stamps it as `source.platform`, which the readers folding
   *  those facts require (their contract's `trust`); the fixed point is what no rewrite rule
   *  redirects, so nothing else runs under it. */
  platform?: true;
};
/** The grant's header beside it (the caller's `grant`), set and stripped exactly where the
 *  principal's is. */
export const ITX_GRANT_HEADER = "x-itx-grant";
/** The header a loaded worker's `env.ITX.fetch` sets on the Request it forwards, so the context's
 *  fetch runs the call as app code; stripped from every Request that arrives from outside. */
export const ITX_APP_HEADER = "x-itx-app";
/** Originating context of a native fetch forwarded by a trusted context. */
export const ITX_CALLER_PATH_HEADER = "x-itx-caller-path";

/** THE PROVENANCE STAMP (iterate/stream/processor `EventSource`): the event as the log stores it,
 *  its `source` built WHOLE from the admitted caller — a writer's own is dropped, so nothing forges
 *  its origin, principal, grant or platform. `origin` is where the call started (`Caller.path`,
 *  stamped at the first hop), else `here`, the context appended to. */
export function stampCaller<E extends { source?: unknown }>(
  event: E,
  caller: Caller,
  here: string,
): E & { source: EventSource } {
  return {
    ...event,
    source: {
      origin: caller.path || here,
      ...(caller.principal && { principal: caller.principal }),
      ...(caller.principal && caller.grant && { grant: caller.grant }),
      ...(caller.platform && { platform: true as const }),
    },
  };
}

/** The stamp of what the platform writes as the context at `here` itself: its birth and wake, a
 *  run's settlement, a child's announcement, the un-set of a dead lend's rows. */
export const platformSource = (here: string): EventSource => ({ origin: here, platform: true });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Bytes as base64url, unpadded. */
export const base64url = (bytes: Uint8Array): string =>
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

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Sign JSON claims (HMAC) for the platform's own tokens: the login flow's cookie, signed file URLs,
 *  secret-OAuth state. */
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

/** The SHA-256 of `text`, hex: what the platform keeps of a random token (an invitation link, a
 *  personal access token, a mailed code), and a secret derived from `secrets.key` under a label
 *  (app-config.ts `sessionSigningSecretOf`, test-link.ts). */
export const sha256Hex = async (text: string): Promise<string> =>
  Array.from(await sha256(text), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Whether two secrets are the same, in time that depends on neither where they differ nor how
 *  long they are: both are SHA-256 hashed and every byte of the digests compared, no early exit.
 *  An XOR loop, not Workers' `crypto.subtle.timingSafeEqual`, which node (the unit tests) lacks. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

/** The principal the admin secret grants — `{ actor: "admin" }`, every project — when `candidate`
 *  IS `secret` (`APP_CONFIG_ADMIN_API_SECRET`: at `authenticate({ type: "admin-secret" })`, and as
 *  a bearer on `/api` — oauth.ts refuses it at `/mcp`), else null, by `secretsEqual`. A blank
 *  secret matches nothing. */
export async function verifyAdminSecret(
  candidate: string,
  secret: string,
): Promise<{ actor: "admin" } | null> {
  return secret && (await secretsEqual(candidate, secret)) ? { actor: "admin" } : null;
}
