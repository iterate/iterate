import {
  AuthorizationError,
  GrantType,
  OAuthAuthorizationServer,
  OAuthError,
  type AuthRequest,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
  type ValidatedAccessToken,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { reportIssue } from "iterate/lib";
import { OAuthScope, OAuthScopes } from "iterate/oauth-scopes";
import type { Principal } from "iterate/principal";
import { secretsEqual, sha256Hex, verifyAdminSecret } from "./caller.ts";
import type { Env } from "./env.ts";
import type { AccountState, GrantUsed } from "./account/contract.ts";
import { appendPlatformFacts, ownerContext } from "./session.ts";
import { type Reach } from "./control-plane/edge.ts";
import { emailAllowed } from "./allowed-emails.ts";
import { appConfigOf, platformAddressesOf, type PlatformAddresses } from "./app-config.ts";
import { providerStore } from "./oauth-store.ts";
import { isDeployReset, isRetryableTransportError } from "./retryable-error.ts";
import { watchSlowStep } from "./sign-in-watch.ts";
import {
  isPersonalAccessToken,
  parsePersonalAccessToken,
  personalAccessTokenIndexed,
} from "./personal-access-token.ts";

/** Encrypted by the provider. Every grant is created through parseAuthorization, so it is bound to
 * one of the authorization server's resources: the issuer's own session or a client's. */
export const GrantProps = z.object({
  kind: z.enum(["issuer", "app"]),
  userId: z.string().startsWith("user_"),
  email: z.string(),
  /** the identity provider's picture and display name of the person (when the provider supplies them), shown where the
   *  grant's session is — the consent page's "signed in as"; the name seeds the onboarding step's
   *  organization name */
  picture: z.string().optional(),
  name: z.string().optional(),
  /** An issuer session a preview's test link started (test-link.ts, issuer-session.ts
   *  `testLinkResponse`): the sibling app previews' origins the link signed, and the test person's
   *  project — consent.ts approves such a client for that project without the Allow page. */
  testLink: z.object({ clients: z.array(z.string()), project: z.string() }).optional(),
  projects: z.array(z.string()).nullable(),
  /** Epoch ms: the grant is refused from here on, however recently it was used (`grantLifetime`). */
  deadline: z.number().int().positive(),
  /** A PLATFORM ADMIN SIGNED IN AS THIS PERSON (consent.ts `#impersonate`): the grant is the
   *  person's, and the admin is stamped beside them on every call — `Principal.impersonatedBy`, the
   *  same shape. */
  impersonatedBy: z.object({ actor: z.string().startsWith("user_"), email: z.string() }).optional(),
});
export type GrantProps = z.infer<typeof GrantProps>;

/** What the provider stores with each access token (`grantLifetime` returns it): the grant's props
 *  and its id, which the provider's validation does not report. */
const TokenProps = GrantProps.extend({
  /** The provider mints it (16 url-safe characters); MCP stamps it on project-root run requests. */
  grantId: z.string().min(1),
});

/** A grant as its bearer presents it: an OAuth access token's props, with the token's scope and
 *  expiry (epoch ms) as the provider verified them (`ctx.auth`), or a personal access token
 *  (`personal`, personal-access-token.ts: the key's id is its `grantId`, and a key that never expires
 *  has an `expiresAt` and a `deadline` of `Infinity`). */
export type AccessGrant = Omit<z.infer<typeof TokenProps>, "kind"> & {
  kind: GrantProps["kind"] | "personal";
  scope: string[];
  expiresAt: number;
  /** When the person's account last recorded a use of the grant (epoch ms, `grantUses`), as the
   *  admission's own read of the account found it; absent when it never has. `recordGrantUse`
   *  reads it. */
  lastUsedAt?: number;
};

export type Authorization = {
  principal: Principal;
  reach: Reach;
  /** Null only for the configured administrator credential. */
  grant: AccessGrant | null;
};

/** How long an interactive grant lives unused: every refresh moves its expiry this far on
 *  (`refreshTokenIdleTTL`, the library's README "PKCE and token lifecycle"), never past its
 *  `deadline` (`grantLifetime`). */
const SESSION_IDLE_SECONDS = 7 * 24 * 3600;
/** An access token's lifetime; `grantLifetime` shortens it to the grant's deadline. */
const ACCESS_TOKEN_SECONDS = 3600;

/** The provider validates the client, redirect, PKCE and the resource: one of the two the
 * authorization server declares (a request naming none, both, or another is `invalid_target`). We
 * own the scopes. */
export async function parseAuthorization(env: Env, request: Request): Promise<AuthRequest> {
  const auth = await oauthHelpers(env, platformAddressesOf(env, request)).parseAuthRequest(request);
  const scopes = OAuthScopes.safeParse(auth.scope);
  if (!scopes.success)
    throw new AuthorizationError("invalid_scope", {
      description: "This API supports iterate and account scopes.",
      redirectUri: auth.redirectUri,
      state: auth.state,
      issuer: auth.issuer,
    });
  return { ...auth, scope: scopes.data };
}

/** THE ACCOUNT'S STATE — the person's own record (src/account/contract.ts), read AT HEAD from the
 *  `account` facet on `/users/<id>` (the facet catches up from its log before answering): whether
 *  a grant has ended (`endedGrants`, the revocation truth — grants.ts lands the end there and
 *  awaits it), when each was last used. One hop to the person's own Durable Object.
 *
 *  Read again ONCE, on a fresh stub, when the read was cut at the transport (retryable-error.ts):
 *  every admission and every code exchange reads here (`grantLifetime`), so a deploy's reset of
 *  the person's Durable Object would otherwise fail a sign-in's token request with a 500. The read
 *  is idempotent; a second failure throws. A deploy's reset is expected; any other cut is a
 *  platform failure the prd fault alarm counts.
 *
 *  A read still pending after five seconds logs `oauth.step-slow` naming the person while it waits
 *  (sign-in-watch.ts). A person's account is often brand new at their first sign-in's code
 *  exchange, and Cloudflare can hold a new Durable Object's answers until its first write is
 *  confirmed. */
export async function accountStateOf(env: Env, userId: string): Promise<AccountState> {
  // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; the facet is the
  // platform's own AccountDurableObject and `snapshot()` the engine's `{ offset, state }`.
  const read = async () =>
    (
      (await watchSlowStep(
        { event: "oauth.step-slow", step: "account-state", userId },
        ownerContext(env.ITERATE_CONTEXT, { account: userId }).invoke(
          ["itx", "facets", ["get", "account"], ["snapshot"]],
          [],
          { principal: null },
        ),
      )) as { state: AccountState }
    ).state;
  try {
    return await read();
  } catch (error) {
    if (!isRetryableTransportError(error)) throw error;
    console.warn({
      event: isDeployReset(error)
        ? "oauth.deploy-reset-account-state-retry"
        : "oauth.platform-failure-account-state-retry",
      name: "account-state",
      userId,
      message: String(error),
    });
    return read();
  }
}

/** Whether `email` is one of the deployment's platform admins (app-config.ts `admins`), as the
 *  configuration reads now. */
export function isAdmin(env: Env, email: string): boolean {
  return appConfigOf(env).admins.includes(email.trim().toLowerCase());
}

/** A grant's admin claims, against the `admins` list as it reads NOW: the `admin` scope needs its
 *  own person listed, an impersonation its admin. Every admission and every refresh asks, so an
 *  address the list drops loses both at its next request. */
function grantAdminsStillListed(
  env: Env,
  grant: Pick<GrantProps, "email" | "impersonatedBy"> & { scope: readonly string[] },
): boolean {
  if (grant.scope.includes("admin") && !isAdmin(env, grant.email)) return false;
  return !grant.impersonatedBy || isAdmin(env, grant.impersonatedBy.email);
}

/** Whether `grant` still admits its bearer: its token unexpired, its deadline not passed, its
 * person's email one `login.allowedEmails` admits, its admins still listed (`grantAdminsStillListed`),
 * and no end on the person's account. A fresh read of the account on each admission — never memoized: provider
 * KV expiry/deletion alone cannot deny a token during propagation or a refresh racing with logout,
 * and a memo here would let a revoked grant through for its life. (The live socket's 30 s
 * re-check, rpc.ts, is the one lag anywhere.) */
export async function grantIsLive(env: Env, grant: AccessGrant): Promise<boolean> {
  return Boolean(await liveGrantAccount(env, grant));
}

/** The person's account as `grantIsLive` reads it, or null when the grant no longer admits its
 *  bearer: an admission keeps what the read found (`lastUsedAt`) instead of reading it again. */
async function liveGrantAccount(env: Env, grant: AccessGrant): Promise<AccountState | null> {
  if (
    grant.expiresAt <= Date.now() ||
    grant.deadline <= Date.now() ||
    !emailAllowed(appConfigOf(env).login.allowedEmails, grant.email) ||
    !grantAdminsStillListed(env, grant)
  )
    return null;
  const account = await accountStateOf(env, grant.userId);
  return account.endedGrants[grant.grantId] ? null : account;
}

/** THE PLATFORM'S TOKEN VALIDATOR, for every resource (api.ts hosts each with it). Three bearers:
 *  - a token the authorization server issued for `resource` (audience-checked, its props
 *    decrypted) whose grant is still live;
 *  - a personal access token (personal-access-token.ts), at any resource: the library's
 *    resource servers take any validator ("`validateToken` is just a function",
 *    docs/resource-servers.md "Another issuer, at your own risk"), so the key's check is a branch
 *    here, and it names the resource that asked as its audience. At `/mcp` a key is outside the MCP
 *    authorization profile (docs/advanced-configuration.md, "MCP compatibility warning"), which
 *    asks for a token issued for that resource: the platform accepts one anyway, so a person can
 *    use the key they made in an MCP client, and MCP never forwards it anywhere;
 *  - the operator's bearer, at `/api` alone: the deployment's machine credential for automation (the
 *    e2e harness, deploy gates, load scripts). It is refused at `/mcp`, where an MCP client would
 *    hold it.
 *  The props are the platform's `Authorization`, what the resource's handler reads as `ctx.props`.
 *  Null refuses the bearer (the resource server's 401 challenge), logged as an `oauth.refusal` like
 *  the authorization server's own (`onError`). No bearer is ever logged. */
export async function validateToken(
  env: Env,
  addresses: PlatformAddresses,
  resource: string,
  token: string,
) {
  if (isPersonalAccessToken(token)) {
    const admission = await personalAccessTokenAdmission(env, token);
    if (!admission.ok) {
      logRefusal(resource, admission.reason);
      return null;
    }
    const { grant } = admission.authorization;
    return {
      props: admission.authorization,
      audience: resource,
      scope: grant.scope,
      userId: grant.userId,
      ...(Number.isFinite(grant.expiresAt) && { expiresAt: Math.floor(grant.expiresAt / 1000) }),
    };
  }
  const libraryToken = new TextEncoder().encode(token).byteLength <= LIBRARY_TOKEN_MAX_BYTES;
  const validated = libraryToken
    ? await authorizationServer(env, addresses).validateToken(resource, token, providerEnv(env))
    : null;
  if (validated) {
    const authorization = await authorizationOf(env, validated);
    if (!authorization) {
      logRefusal(resource, "grant_not_live");
      return null;
    }
    // consent grants `admin` for `/api` alone; an MCP client holding every project is refused, as
    // the operator bearer is
    if (authorization.reach === "every" && resource !== addresses.api) {
      logRefusal(resource, "admin_scope_not_accepted");
      return null;
    }
    return { ...validated, props: authorization };
  }
  if (await verifyAdminSecret(token, appConfigOf(env).secrets.adminBearer.exposeSecret())) {
    if (resource === addresses.api)
      return {
        props: {
          principal: { actor: "admin" },
          reach: "every",
          grant: null,
        } satisfies Authorization,
        audience: resource,
        scope: [...OAuthScope.options],
      };
    logRefusal(resource, "operator_bearer_not_accepted");
    return null;
  }
  // Why the library said no, read again only now: a token it holds for the other resource, or none.
  const held = libraryToken && (await oauthHelpers(env, addresses).unwrapToken(token));
  logRefusal(resource, held ? "audience_mismatch" : "token_unknown_or_expired");
  return null;
}

/** A bearer the resource refused, as the authorization server's refusals are logged (`onError`):
 *  its category, the check that failed and, outside the resource servers, the entry point it came
 *  to. */
export function logRefusal(resource: string, reason: string, entryPoint?: BearerEntryPoint) {
  console.warn({
    event: "oauth.refusal",
    category: "protected-resource",
    reason,
    resource,
    entryPoint,
  });
}

/** The longest bearer the library is asked about. Its tokens are about 90 characters, and it looks
 *  one up by a KV key made of the bearer's own parts: past KV's 512-byte key limit the lookup
 *  throws, which would answer a stranger's bearer with a 503 and a reported issue. */
const LIBRARY_TOKEN_MAX_BYTES = 256;

/** Where a bearer is presented outside the resource servers' handlers: `/api`'s own in-band
 *  `authenticate` on a bare socket (rpc.ts), a project host (worker.ts), a browser session's held
 *  token (browser-client.ts) and a secret's OAuth callback (secret-oauth-callback.ts). */
export type BearerEntryPoint = "api" | "project-host" | "browser-session" | "secret-oauth-callback";

/** A bearer as `/api` admits it, at an entry point where no resource server's handler runs
 * (`BearerEntryPoint`). An OAuth token for `/mcp` is no token here; a personal access token is. The
 * operator's bearer is `/api`'s alone: admitted in-band there, refused at every other entry point
 * (a project host would hand its app `{ actor: "admin" }` over every project, the callback would
 * let it complete any project's consent), and logged as `operator_bearer_not_accepted`. */
export async function authorizationForToken(
  env: Env,
  token: string,
  addresses: PlatformAddresses,
  entryPoint: BearerEntryPoint,
): Promise<Authorization | null> {
  const validation = await validateToken(env, addresses, addresses.api, token);
  if (!validation) return null;
  if (!validation.props.grant && entryPoint !== "api") {
    logRefusal(addresses.api, "operator_bearer_not_accepted", entryPoint);
    return null;
  }
  // A platform admin's grant is `/api`'s alone, like the operator bearer: a project host would
  // count its holder a member of every project.
  if (validation.props.reach === "every" && entryPoint !== "api") {
    logRefusal(addresses.api, "admin_scope_not_accepted", entryPoint);
    return null;
  }
  if (validation.scope.includes("iterate")) return validation.props;
  logRefusal(addresses.api, "insufficient_scope", entryPoint);
  return null;
}

/** How often a grant's use is recorded: once an hour per grant, so the account's log stays a
 *  summary and the sessions page's "last used" is right to the hour. What says a use is recent is
 *  the account itself, as the admission read it (`lastUsedAt`), since a fresh isolate (every deploy
 *  starts them) has no memo of its own. The isolate's memo covers what that read cannot: a held
 *  socket (rpc.ts), whose admission is as old as the socket. */
const GRANT_USE_MEMO_MS = 3600_000;
const grantUseRecordedAt = new Map<string, number>();

/** A grant's use, as a fact on the person's account (`account/grant-used`, src/account/contract.ts)
 *  — off the response path (every caller `waitUntil`s it), at most hourly per grant. Revocation
 *  reads nothing here: every admission reads the account's `endedGrants` whatever this skips. */
export async function recordGrantUse(env: Env, grant: AccessGrant): Promise<void> {
  const now = Date.now();
  const key = `${grant.userId}:${grant.grantId}`;
  const recordedAt = Math.max(grant.lastUsedAt ?? 0, grantUseRecordedAt.get(key) ?? 0);
  if (recordedAt > now - GRANT_USE_MEMO_MS) return;
  grantUseRecordedAt.set(key, now);
  try {
    await appendPlatformFacts(
      env.ITERATE_CONTEXT,
      { account: grant.userId },
      {
        type: "events.iterate.com/account/grant-used",
        payload: { grantId: grant.grantId, at: now } satisfies GrantUsed,
      },
      {
        // an impersonation's use names the admin beside the person, as every event it causes does
        principal: {
          actor: grant.userId,
          email: grant.email,
          // oxlint-disable-next-line iterate/simple-truthiness-check -- as `authorizationOf`'s principal: only an impersonation carries the key
          ...(grant.impersonatedBy && { impersonatedBy: grant.impersonatedBy }),
        },
        grant: grant.grantId,
      },
    );
  } catch (error) {
    grantUseRecordedAt.delete(key); // the next use tries again
    reportIssue("oauth.grant-use-not-recorded", error, { grantId: grant.grantId });
  }
}

/** The authorization server's helpers (`OAuthHelpers`): parse and complete an authorization, look
 *  up and create clients, list and revoke a person's grants. */
export function oauthHelpers(env: Env, addresses: PlatformAddresses) {
  return authorizationServer(env, addresses).getOAuthApi(providerEnv(env));
}

/** A request to the authorization server's own endpoints (api.ts routes them here): its metadata,
 *  token (and revocation) and registration endpoints. */
export function authorizationServerFetch(
  env: Env,
  addresses: PlatformAddresses,
  request: Request,
  ctx: ExecutionContext,
) {
  return authorizationServer(env, addresses).fetch(request, providerEnv(env), ctx);
}

/** The provider's rows for a grant go — AFTER its end landed on the person's account and was
 * awaited (grants.ts): from that fact on every admission is refused (`grantIsLive`), so a
 * provider cleanup that fails costs nothing but a row the provider's own expiry reaps. */
export async function revokeGrant(
  env: Env,
  addresses: PlatformAddresses,
  grant: { userId: string; grantId: string },
): Promise<void> {
  try {
    await oauthHelpers(env, addresses).revokeGrant(grant.grantId, grant.userId);
  } catch (error) {
    reportIssue("oauth.revoke-cleanup-failed", error, {
      userId: grant.userId,
      grantId: grant.grantId,
    });
  }
}

/** The authorization server's endpoints on the platform origin (api.ts routes the token and
 *  registration endpoints to it; the authorize endpoint is the issuer's consent page). */
const AUTHORIZE_ENDPOINT = "/oauth2/auth";
export const TOKEN_ENDPOINT = "/oauth2/token";
export const CLIENT_REGISTRATION_ENDPOINT = "/oauth2/register";

/** THE AUTHORIZATION SERVER at `addresses` (the library's role-based API, its
 *  docs/resource-servers.md "Same Worker"): the issuer, for the platform's three resources, `/api`
 *  (Cap'n Web), `/mcp` and `/oauth2/userinfo` (who the bearer is, and nothing else — what another
 *  deployment asks to know an admin by, test-link.ts) — each hosted in this worker by api.ts. Every
 *  grant and access token is bound to exactly one of them (RFC 8707): a userinfo token is refused
 *  at `/api` and `/mcp` by the audience check itself. Built per request: where `urls.os` is unset the addresses
 *  are the request's own. */
function authorizationServer(env: Env, { platformOrigin, api, mcp, userinfo }: PlatformAddresses) {
  return new OAuthAuthorizationServer<Env>({
    issuer: platformOrigin,
    resources: [api, mcp, userinfo],
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    // DCR is served on every deployment (not just local http): CIMD stays the apps' own path
    // (iterate/app-session.ts uses a client-id metadata document), but standard MCP clients (the MCP
    // Inspector, Claude's connector) require dynamic registration, so the endpoint is always published.
    clientRegistrationEndpoint: CLIENT_REGISTRATION_ENDPOINT,
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: OAuthScope.options,
    accessTokenTTL: ACCESS_TOKEN_SECONDS,
    refreshTokenTTL: SESSION_IDLE_SECONDS,
    refreshTokenIdleTTL: SESSION_IDLE_SECONDS,
    tokenExchangeCallback: (input) => grantLifetime(env, input),
    // Each refusal by the check that failed (`internal`, the library's
    // docs/advanced-configuration.md "The internal reason"); the wire stays generic. `detail` is
    // context such as a caught error or a client metadata document's fetch failure, never a secret.
    onError: ({ code, status, internal }) => {
      console.warn({
        event: "oauth.refusal",
        code,
        status,
        category: internal.category,
        reason: internal.reason,
        detail: internal.detail instanceof Error ? String(internal.detail) : internal.detail,
      });
    },
  });
}

/** A validated token as the platform's authorization, or null when its grant is no longer live. A
 *  platform admin's grant (the `admin` scope, its person listed: `liveGrantAccount`) reaches every
 *  project as that person; an impersonation reaches what the person does, the admin named beside
 *  them. */
async function authorizationOf(
  env: Env,
  token: ValidatedAccessToken,
): Promise<Authorization | null> {
  const props = TokenProps.safeParse(token.props);
  if (!props.success || props.data.userId !== token.userId) return null;
  // the deadline bounds the token too (`grantLifetime`), so every check of `expiresAt` — a batch's
  // calls (rpc.ts), a socket's lease (project-host-lease.ts) — honours it
  const grant = {
    ...props.data,
    scope: token.scope,
    expiresAt: Math.min(token.expiresAt * 1000, props.data.deadline),
  };
  const account = await liveGrantAccount(env, grant);
  if (!account) return null;
  return {
    principal: {
      actor: grant.userId,
      email: grant.email,
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the principal crosses Cap'n Web and JSON to callers (`whoami`, a project host's header): an `impersonatedBy: undefined` key arrives there as a key, so only an impersonation carries one
      ...(grant.impersonatedBy && { impersonatedBy: grant.impersonatedBy }),
    },
    reach: grant.scope.includes("admin")
      ? "every"
      : // oxlint-disable-next-line iterate/simple-truthiness-check -- `reach` is discriminated with `"projectIds" in reach` (session.ts, control-plane/edge.ts) and TS narrows on that key, so a present-but-undefined key would both misread as a bound grant and break the narrowing; the conditional spread stays (grant.projects is string[] | null)
        { userId: grant.userId, ...(grant.projects && { projectIds: grant.projects }) },
    grant: { ...grant, lastUsedAt: account.grantUses[grant.grantId]?.at },
  };
}

/** A personal access token's admission: the index holds the bearer's SHA-256 under the key it
 *  names (personal-access-token.ts), then a fresh read of the person's account on every request, as
 *  `grantIsLive` makes for an OAuth grant: the key's record, with that SHA-256, not ended, not
 *  expired, and for an email `login.allowedEmails` admits. The bearer acts as the person, with
 *  `iterate` alone, on the projects the key covers: a key manages no sessions and no
 *  organizations, so a leaked one mints no other. A malformed, forged or unknown key, a wrong
 *  secret or a revoked key (its index entry gone) is `token_unknown_or_expired`, like a token the
 *  library does not hold; an ended one the index still holds, or one whose email the list no
 *  longer names, `grant_not_live`. */
async function personalAccessTokenAdmission(
  env: Env,
  token: string,
): Promise<
  | { ok: true; authorization: Authorization & { grant: AccessGrant } }
  | { ok: false; reason: "token_unknown_or_expired" | "grant_not_live" }
> {
  const named = parsePersonalAccessToken(token);
  if (!named) return { ok: false, reason: "token_unknown_or_expired" };
  const hash = await sha256Hex(token);
  // THE INDEX FIRST (personal-access-token.ts): a key it does not hold is refused on one KV read, so
  // a forged key dials no Durable Object, neither a stranger's (which would be created) nor a real
  // person's (whose account every one of their grants reads).
  if (!(await personalAccessTokenIndexed(env.OAUTH_KV, hash, named)))
    return { ok: false, reason: "token_unknown_or_expired" };
  const account = await accountStateOf(env, named.userId);
  const key = account.personalAccessTokens[named.id];
  if (!key || !(await secretsEqual(hash, key.hash)))
    return { ok: false, reason: "token_unknown_or_expired" };
  const expiresAt = key.expiresAt ?? Infinity;
  if (expiresAt <= Date.now()) return { ok: false, reason: "token_unknown_or_expired" };
  if (
    account.endedGrants[named.id] ||
    !emailAllowed(appConfigOf(env).login.allowedEmails, key.email)
  )
    return { ok: false, reason: "grant_not_live" };
  const grant: AccessGrant = {
    kind: "personal",
    userId: named.userId,
    email: key.email,
    projects: key.projects,
    deadline: expiresAt,
    grantId: named.id,
    scope: ["iterate"],
    expiresAt,
    lastUsedAt: account.grantUses[named.id]?.at,
  };
  return {
    ok: true,
    authorization: {
      principal: { actor: named.userId, email: key.email },
      reach: { userId: named.userId, projectIds: key.projects },
      grant,
    },
  };
}

/** A GRANT'S LIFETIME, decided at its code exchange and at every refresh — the library's
 *  `tokenExchangeCallback`, "the place for lifetime policy" (docs/advanced-configuration.md,
 *  "Sliding expiry"). A grant whose end is on the person's account, or past its `deadline`, is
 *  refused. Every grant lives a week unused (the server's `refreshTokenTTL` and
 *  `refreshTokenIdleTTL`), and within a week of its deadline, 30 days after the sign-in or consent
 *  that made it, only until that deadline. */
async function grantLifetime(
  env: Env,
  input: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult> {
  const refused = (reason: string, description: string) =>
    new OAuthError("invalid_grant", {
      description,
      internal: { category: "grant-lifetime", reason },
    });
  const parsed = GrantProps.safeParse(input.props);
  if (!parsed.success || parsed.data.userId !== input.userId)
    throw refused("props_invalid", "The session is no longer active.");
  if ((await accountStateOf(env, input.userId)).endedGrants[input.grantId])
    throw refused("grant_ended", "The session is no longer active.");
  const grant = parsed.data;
  if (!emailAllowed(appConfigOf(env).login.allowedEmails, grant.email))
    throw refused("email_not_allowed", "The session is no longer active.");
  if (!grantAdminsStillListed(env, { ...grant, scope: input.scope }))
    throw refused("admin_not_listed", "The session is no longer active.");
  const remaining = Math.floor((grant.deadline - Date.now()) / 1000);
  // KV's shortest expiry, below which the library refuses a lifetime (`invalid_request`).
  if (remaining < 60) throw refused("deadline_passed", "The session has expired.");
  // No access token outlives the deadline either: an hour's impersonation whose code is exchanged
  // late gets a token that ends with the hour, not the library's hour from the exchange.
  const token = {
    accessTokenProps: { ...grant, grantId: input.grantId },
    accessTokenTTL: Math.min(ACCESS_TOKEN_SECONDS, remaining),
  };
  if (remaining >= SESSION_IDLE_SECONDS) return token;
  // The library honors `refreshTokenTTL` only at the code exchange and `refreshTokenIdleTTL` only at
  // a refresh, and refuses either key anywhere else.
  return input.grantType === GrantType.AUTHORIZATION_CODE
    ? { ...token, refreshTokenTTL: remaining }
    : { ...token, refreshTokenIdleTTL: remaining };
}

/** The env the provider runs over: the worker's, with `OAUTH_KV` the provider's store
 *  (oauth-store.ts), whose grants live in the control plane. */
const providerEnv = (env: Env): Env => ({ ...env, OAUTH_KV: providerStore(env) });
