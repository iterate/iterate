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
import { verifyAdminSecret } from "./caller.ts";
import type { Env } from "./env.ts";
import type { AccountState, GrantUsed } from "./account/contract.ts";
import { appendPlatformFacts, ownerContext } from "./session.ts";
import { type Reach } from "./control-plane/edge.ts";
import { appConfigOf, platformAddressesOf, type PlatformAddresses } from "./app-config.ts";
import { providerStore } from "./oauth-store.ts";

/** Encrypted by the provider. Every grant is created through parseAuthorization, so it is bound to
 * one of the authorization server's two resources. */
export const GrantProps = z.object({
  kind: z.enum(["issuer", "app", "personal"]),
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
});
export type GrantProps = z.infer<typeof GrantProps>;

/** What the provider stores with each access token (`grantLifetime` returns it): the grant's props
 *  and its id, which the provider's validation does not report. */
const TokenProps = GrantProps.extend({
  /** The provider mints it (16 url-safe characters); MCP stamps it on project-root run requests. */
  grantId: z.string().min(1),
});

/** A grant as one of its access tokens presents it: the props, with the token's scope and expiry
 *  (epoch ms) as the provider verified them (`ctx.auth`). */
export type AccessGrant = z.infer<typeof TokenProps> & { scope: string[]; expiresAt: number };

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
 *  awaits it), when each was last used. One hop to the person's own Durable Object. */
export async function accountStateOf(env: Env, userId: string): Promise<AccountState> {
  // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; the facet is the
  // platform's own AccountDurableObject and `snapshot()` the engine's `{ offset, state }`.
  const { state } = (await ownerContext(env.ITERATE_CONTEXT, { account: userId }).invoke(
    ["itx", "facets", ["get", "account"], ["snapshot"]],
    [],
    { principal: null },
  )) as { state: AccountState };
  return state;
}

async function grantIsRevoked(env: Env, userId: string, grantId: string): Promise<boolean> {
  return Boolean((await accountStateOf(env, userId)).endedGrants[grantId]);
}

/** Whether `grant` still admits its bearer: its token unexpired, its deadline not passed, and no end
 * on the person's account. A fresh read of the account on each admission — never memoized: provider
 * KV expiry/deletion alone cannot deny a token during propagation or a refresh racing with logout,
 * and a memo here would let a revoked grant through for its life. (The live socket's 30 s
 * re-check, rpc.ts, is the one lag anywhere.) */
export async function grantIsLive(env: Env, grant: AccessGrant): Promise<boolean> {
  return (
    grant.expiresAt > Date.now() &&
    grant.deadline > Date.now() &&
    !(await grantIsRevoked(env, grant.userId, grant.grantId))
  );
}

/** THE PLATFORM'S TOKEN VALIDATOR, for either resource (api.ts hosts both with it): a token the
 *  authorization server issued for `resource` (audience-checked, its props decrypted) whose grant
 *  is still live, else the operator's bearer. The props are the platform's `Authorization` — what
 *  the resource's handler reads as `ctx.props`. Null refuses the bearer (the resource server's 401
 *  challenge). The operator's bearer is no token of this server's: like any other credential a
 *  resource accepts on its own terms (the library's docs/resource-servers.md, "Another issuer, at
 *  your own risk"), it is accepted at both resources, with every scope. */
export async function validateToken(
  env: Env,
  addresses: PlatformAddresses,
  resource: string,
  token: string,
) {
  const validated = await authorizationServer(env, addresses).validateToken(
    resource,
    token,
    providerEnv(env),
  );
  if (validated) {
    const authorization = await authorizationOf(env, validated);
    return authorization && { ...validated, props: authorization };
  }
  if (!(await verifyAdminSecret(token, appConfigOf(env).secrets.adminBearer.exposeSecret())))
    return null;
  return {
    props: { principal: { actor: "admin" }, reach: "every", grant: null } satisfies Authorization,
    audience: resource,
    scope: [...OAuthScope.options],
  };
}

/** A bearer as `/api` admits it, where no resource server's handler runs: a project host's bearer,
 * a bare socket's in-band `authenticate` (rpc.ts), a browser session's held token (browser-client.ts).
 * A token for `/mcp` is no token here. */
export async function authorizationForToken(
  env: Env,
  token: string,
  addresses: PlatformAddresses,
): Promise<Authorization | null> {
  const validation = await validateToken(env, addresses, addresses.api, token);
  return validation?.scope.includes("iterate") ? validation.props : null;
}

/** How often a grant's use is recorded: once an hour per grant per isolate, so the account's log
 *  stays a summary and the sessions page's "last used" is right to the hour. */
const GRANT_USE_MEMO_MS = 3600_000;
const grantUseRecordedAt = new Map<string, number>();

/** A grant's use, as a fact on the person's account (`account/grant-used`, src/account/contract.ts)
 *  — off the response path (every caller `waitUntil`s it), at most hourly per grant per isolate. */
export async function recordGrantUse(env: Env, grant: AccessGrant): Promise<void> {
  const now = Date.now();
  const key = `${grant.userId}:${grant.grantId}`;
  if ((grantUseRecordedAt.get(key) ?? 0) > now - GRANT_USE_MEMO_MS) return;
  grantUseRecordedAt.set(key, now);
  try {
    await appendPlatformFacts(
      env.ITERATE_CONTEXT,
      { account: grant.userId },
      {
        type: "events.iterate.com/account/grant-used",
        payload: { grantId: grant.grantId, at: now } satisfies GrantUsed,
      },
      { principal: { actor: grant.userId, email: grant.email }, grant: grant.grantId },
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
 * awaited (grants.ts): from that fact on every admission is refused (`grantIsRevoked`), so a
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

/** THE AUTHORIZATION SERVER at `addresses` (the library's role-based API, its
 *  docs/resource-servers.md "Same Worker"): the issuer, for the platform's two resources, `/api`
 *  (Cap'n Web) and `/mcp` — each hosted in this worker by api.ts. Every grant and access token is
 *  bound to exactly one of them (RFC 8707). Built per request: where `urls.os` is unset the addresses
 *  are the request's own. */
function authorizationServer(env: Env, { platformOrigin, api, mcp }: PlatformAddresses) {
  return new OAuthAuthorizationServer<Env>({
    issuer: platformOrigin,
    resources: [api, mcp],
    authorizeEndpoint: "/oauth2/auth",
    tokenEndpoint: "/oauth2/token",
    // DCR is served on every deployment (not just local http): CIMD stays the apps' own path
    // (iterate/app-session.ts uses a client-id metadata document), but standard MCP clients (the MCP
    // Inspector, Claude's connector) require dynamic registration, so the endpoint is always published.
    clientRegistrationEndpoint: "/oauth2/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: OAuthScope.options,
    refreshTokenTTL: SESSION_IDLE_SECONDS,
    refreshTokenIdleTTL: SESSION_IDLE_SECONDS,
    tokenExchangeCallback: (input) => grantLifetime(env, input),
    // Each refusal by the check that failed (`internal`, the library's
    // docs/advanced-configuration.md "The internal reason"); the wire stays generic.
    onError: ({ code, status, internal }) => {
      console.warn({
        event: "oauth.refusal",
        code,
        status,
        category: internal.category,
        reason: internal.reason,
      });
    },
  });
}

/** A validated token as the platform's authorization, or null when its grant is no longer live. */
async function authorizationOf(
  env: Env,
  token: ValidatedAccessToken,
): Promise<Authorization | null> {
  const props = TokenProps.safeParse(token.props);
  if (!props.success || props.data.userId !== token.userId) return null;
  const grant = { ...props.data, scope: token.scope, expiresAt: token.expiresAt * 1000 };
  if (!(await grantIsLive(env, grant))) return null;
  return {
    principal: { actor: grant.userId, email: grant.email },
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `reach` is discriminated with `"projectIds" in reach` (session.ts, control-plane/edge.ts) and TS narrows on that key, so a present-but-undefined key would both misread as a bound grant and break the narrowing; the conditional spread stays (grant.projects is string[] | null)
    reach: { userId: grant.userId, ...(grant.projects && { projectIds: grant.projects }) },
    grant,
  };
}

/** A GRANT'S LIFETIME, decided at its code exchange and at every refresh — the library's
 *  `tokenExchangeCallback`, "the place for lifetime policy" (docs/advanced-configuration.md,
 *  "Sliding expiry"). A grant whose end is on the person's account, or past its `deadline`, is
 *  refused. A personal token never refreshes: its one access token, and the grant with it, live
 *  until its deadline (30 days by default, up to ten years for a device — grants.ts `mint`). Every
 *  other grant lives `SESSION_IDLE_SECONDS` unused, never past its deadline: 30 days after the
 *  sign-in or consent that made it. */
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
  if (await grantIsRevoked(env, input.userId, input.grantId))
    throw refused("grant_ended", "The session is no longer active.");
  const grant = parsed.data;
  const remaining = Math.floor((grant.deadline - Date.now()) / 1000);
  // KV's shortest expiry, below which the library refuses a lifetime (`invalid_request`).
  if (remaining < 60) throw refused("deadline_passed", "The session has expired.");
  const accessTokenProps = { ...grant, grantId: input.grantId };
  if (grant.kind === "personal") {
    if (input.grantType !== GrantType.AUTHORIZATION_CODE)
      throw refused("personal_token_refresh", "Personal tokens cannot refresh.");
    return { accessTokenProps, accessTokenTTL: remaining, refreshTokenTTL: remaining };
  }
  const lifetime = Math.min(SESSION_IDLE_SECONDS, remaining);
  // The library honors `refreshTokenTTL` only at the code exchange and `refreshTokenIdleTTL` only at
  // a refresh, and refuses either key anywhere else.
  return input.grantType === GrantType.AUTHORIZATION_CODE
    ? { accessTokenProps, refreshTokenTTL: lifetime }
    : { accessTokenProps, refreshTokenIdleTTL: lifetime };
}

/** The env the provider runs over: the worker's, with `OAUTH_KV` the provider's store
 *  (oauth-store.ts), whose grants live in the control plane. */
const providerEnv = (env: Env): Env => ({ ...env, OAUTH_KV: providerStore(env) });
