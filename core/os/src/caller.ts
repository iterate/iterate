// caller.ts — how the platform attributes a call: the `Caller` the edge admits and carries through
// every dispatch, the headers it forwards a caller in, `stampCaller` (the attribution an event is
// stored with), and the token crypto, WebCrypto only: the signed-claims codec, `sha256Hex` and
// `secretsEqual`. Only this worker sets or reads any of it; what user code sees of a caller is the
// SDK's `Principal` and `ITX_PRINCIPAL_HEADER` (iterate/principal).
import { INTEGRATION_PROVIDERS } from "iterate/api";
import { itxExpressionStepName, type ItxExpressionPrefix } from "iterate/expression";
import { codedError } from "iterate/lib";
import type { Principal } from "iterate/principal";
import type { StreamEventInput } from "iterate/stream/processor";
import { storedCause, type Cause } from "./cause.ts";
import type { OnBehalfOf } from "./on-behalf-of.ts";

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
   *  `env.ITX`. Under it the resolver walls the INPUT expression (itx-expression-rewriting.ts
   *  `#admit`: no fixed point); rewrites the owner wrote are never subject. */
  app?: true;
  /** THE PLATFORM ORIGIN the caller reached the platform on — what a public URL is composed from
   *  (`itx.url`, a signed file URL). Absent for a caller with none (a loaded worker's `env.ITX`, the
   *  kernel); the context then uses the last one it was reached on. */
  platformOrigin?: string | null;
  /** Set ONLY by the platform's own code, on the one `itx.builtins.append` of a fact it vouches for
   *  on the principal's behalf — an account's or an organization's (core/os session.ts
   *  `appendPlatformFacts`, the secrets built-ins' catalog cross-post) — never by a client, who never
   *  supplies a Caller. `stampCaller` stamps it as `source.platform`, which the processors folding
   *  those facts require; the fixed point is what no rewrite rule redirects, so nothing else runs
   *  under it. */
  platform?: true;
  /** Set ONLY by the delivery loop, on the call a fan-out row makes to deliver one event (the
   *  context DO's `runAsDelivery`): the SHA-256 of that event's JSON. A target's `deliverEvent`
   *  answers only the event it names, so nothing the call reaches can hand a subscriber an event its
   *  log never held. It rides the delivery's own hops alone (context/built-ins.ts `callContext`). */
  delivery?: string;
  /** WHY the call is made (cause.ts), stamped on every event it appends. Absent where a call begins
   *  a chain: the context it reaches begins one. */
  cause?: Cause;
  /** WHO A SCRIPT RUNS FOR (on-behalf-of.ts): its cause's token, verified by the append that
   *  stamps it (context/built-ins.ts). Attribution only: authority is still the principal's. */
  onBehalfOf?: OnBehalfOf;
  /** THE PERSON THEMSELVES, managing their own account: the principal's own OAuth grant holds the
   *  `account` scope and nobody acts as them (session.ts `#caller`). Absent for a grant bound to
   *  projects or without `account`, an admin's sign-in as someone, the admin secret (with or without
   *  `as`) and the kernel. What connecting their own account to a project needs
   *  (context/built-ins.ts `integrations.connect(provider, { account })`). */
  account?: true;
};
/** The grant's header beside it (the caller's `grant`), set and stripped exactly where the
 *  principal's is. */
export const ITX_GRANT_HEADER = "x-itx-grant";
/** The header a loaded worker's `env.ITX.fetch` sets on the Request it forwards, so the context's
 *  fetch runs the call as app code; stripped from every Request that arrives from outside. */
export const ITX_APP_HEADER = "x-itx-app";
/** Originating context of a native fetch forwarded by a trusted context. */
export const ITX_CALLER_PATH_HEADER = "x-itx-caller-path";

/** THE PROVENANCE STAMP: the event as the log stores it, its `source` the platform's. `origin` is
 *  the context the call started at (`Caller.path`, set at the first hop, else `here`, where the call
 *  runs); `cause`, `principal`, `grant` and `platform` are the admitted caller's. A writer's own `source` is
 *  dropped, all but `processor`, the SDK engine's label for which processor wrote it: the writer's
 *  word, filed under the stamped `origin`. `origin` names the context whose code ran, not who asked
 *  it to run: a `run-requested` anyone appends runs at the context it lands on, and what that script
 *  appends is stamped there. So `origin` is advisory, and a jail is the one boundary in a project. */
export function stampCaller<E extends { source?: StreamEventInput["source"] }>(
  event: E,
  caller: Caller,
  here: string,
): E & { source: NonNullable<StreamEventInput["source"]> } {
  const source: NonNullable<StreamEventInput["source"]> = { origin: caller.path || here };
  if (caller.cause) source.cause = storedCause(caller.cause);
  if (event.source?.processor) source.processor = event.source.processor;
  if (caller.principal) source.principal = caller.principal;
  if (caller.principal && caller.grant) source.grant = caller.grant;
  if (caller.onBehalfOf) source.onBehalfOf = caller.onBehalfOf;
  if (caller.platform) source.platform = true;
  return { ...event, source };
}

/** THE PLATFORM'S IDEMPOTENCY KEYS, which no other writer takes first: a key taken first answers the
 *  platform's fact with the taker's event (a deletion that never starts, a grant that never ends) or
 *  refuses it (a run that never settles, a repo never born). On a global context `account/…` and
 *  `organization/…` are the platform's facts (grants.ts, session.ts), whoever else writes; on a
 *  project's, `itx/…` (a run's settlement, a child's announcement, the apex), `project/…`, an
 *  entity's lifecycle and a secret's lends are, and loaded code — anyone's, since anyone appends
 *  anywhere — writes none of them. */
export function refusePlatformIdempotencyKeys(
  events: readonly { idempotencyKey?: string }[],
  caller: Caller,
  onGlobalContext: boolean,
): void {
  const platformKey = onGlobalContext
    ? !caller.platform && /^(?:account|organization)\//
    : caller.app && /^(?:itx|project|repo|workspace|secret)[/@]/;
  if (!platformKey) return;
  for (const { idempotencyKey } of events)
    if (idempotencyKey && platformKey.test(idempotencyKey))
      throw codedError(
        "FORBIDDEN",
        `idempotency key ${JSON.stringify(idempotencyKey)} is the platform's`,
      );
}

/** THE PLATFORM'S FACTS: the types only the platform appends, each stamped `source.platform` —
 *  whoever reads one trusts it by its type alone (a config repo's `processEvent` switches on it) —
 *  so the append boundary refuses anyone else's (`refuseNonPlatformWrites`), on every context. The
 *  account's, the organization's and the instance's facts on the global contexts are not here:
 *  their processors fold only the platform's stamp, and a person's own append of one stays on their
 *  log as theirs. */
const PLATFORM_FACT_TYPE_LIST = [
  "events.iterate.com/project/worker-updated",
  "events.iterate.com/project/worker-update-failed",
  "events.iterate.com/project/delete-requested",
  "events.iterate.com/email/received",
  "events.iterate.com/email/sent",
  "events.iterate.com/github/webhook-received",
  "events.iterate.com/slack/webhook-received",
  // every provider's connection facts, typed from the provider by the one mechanism that lands them
  // (integrations/connections.ts `appendConnected`, verbs.ts `disconnectIntegration`)
  ...INTEGRATION_PROVIDERS.flatMap(
    (provider) =>
      [
        `events.iterate.com/${provider}/connected`,
        `events.iterate.com/${provider}/disconnected`,
      ] as const,
  ),
] as const;

/** A platform fact's type: what integrations/connections.ts `appendPlatformFact` appends. */
export type PlatformFactType = (typeof PLATFORM_FACT_TYPE_LIST)[number];

export const PLATFORM_FACT_TYPES: ReadonlySet<string> = new Set(PLATFORM_FACT_TYPE_LIST);

/** Whether a rewrite rule's match is on the project's config pointer, `itx.config…`: what every
 *  birth row delivers to and every facet named by `itx.cd('/').config` loads — the platform's
 *  publication alone writes it (project/publication.ts), so its manifest is vouched for. */
export const isConfigPointerMatch = (match: ItxExpressionPrefix) =>
  itxExpressionStepName(match[1]) === "config";

/** THE PLATFORM'S WRITES FROM ANYONE BUT THE PLATFORM ARE REFUSED, on every context: a platform
 *  fact (`PLATFORM_FACT_TYPES`) and a row on the config pointer (`isConfigPointerMatch`: a target, a
 *  mask, a removal), appended or scheduled — an occurrence fires under its schedule's stamp, so what
 *  one may not append it may not schedule. Runs on the normalized batch at the append boundary
 *  (iterate-context-durable-object.ts), and on a deployment's birth events (app-config.ts), which
 *  never pass it. */
export function refuseNonPlatformWrites(events: readonly StreamEventInput[], caller: Caller): void {
  if (caller.platform) return;
  for (const event of events) {
    if (event.type === "events.iterate.com/itx/schedule-set")
      refuseNonPlatformWrites((event.payload as { events: StreamEventInput[] }).events, caller);
    if (PLATFORM_FACT_TYPES.has(event.type))
      throw codedError(
        "FORBIDDEN",
        `${event.type} is the platform's own fact: no one else appends or schedules it`,
      );
    if (
      event.type === "events.iterate.com/itx/rewrite-rule-configured" &&
      isConfigPointerMatch((event.payload as { match: ItxExpressionPrefix }).match)
    )
      throw codedError(
        "FORBIDDEN",
        "`itx.config` is the project's published config: only the platform's publication writes it (commit to /repos/config)",
      );
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Bytes as base64url, unpadded. */
export const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
/** The bytes of base64url text, padded or not. */
export const bytesFromBase64url = (text: string): Uint8Array<ArrayBuffer> =>
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
 *  personal access token, a mailed code), a secret derived from `secrets.key` under a label
 *  (app-config.ts `sessionSigningSecretOf`), and a content identity (exchange code's
 *  `refreshSourceSha256`, a module lock's key). */
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
 *  IS `secret` (`secrets.adminBearer`: at `authenticate({ type: "admin-secret" })`, and as a bearer
 *  on `/api` — oauth.ts refuses it at `/mcp`), else null, by `secretsEqual`. A blank secret matches
 *  nothing. */
export async function verifyAdminSecret(
  candidate: string,
  secret: string,
): Promise<{ actor: "admin" } | null> {
  return secret && (await secretsEqual(candidate, secret)) ? { actor: "admin" } : null;
}
