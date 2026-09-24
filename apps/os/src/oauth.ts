import {
  AuthorizationError,
  OAuthError,
  OAuthProvider,
  getOAuthApi,
  type AuthRequest,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { reportIssue } from "iterate/lib";
import { OAuthScope, OAuthScopes } from "iterate/oauth-scopes";
import { verifyAdminSecret, type Principal } from "iterate/principal";
import type { Env, Handler } from "./env.ts";
import type { AccountState, GrantUsed } from "./account/contract.ts";
import { appendPlatformFacts, ownerContext } from "./session.ts";
import { type Reach } from "./control-plane/edge.ts";
import { appConfigOf, platformAddressesOf, type PlatformAddresses } from "./app-config.ts";
import { providerStore } from "./oauth-store.ts";

/** Encrypted by the provider. Every grant is created through parseAuthorization, so it has a
 * nonempty, allowed resource audience. */
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
  deadline: z.number().int().positive(),
});
export type GrantProps = z.infer<typeof GrantProps>;

const AccessGrant = GrantProps.extend({
  /** The provider mints it (16 url-safe characters); MCP stamps it on project-root run requests. */
  grantId: z.string().min(1),
  scope: z.array(z.string()),
  expiresAt: z.number().int().positive(),
});
export type AccessGrant = z.infer<typeof AccessGrant>;
const AccessProps = z.discriminatedUnion("kind", [
  AccessGrant,
  z.object({ kind: z.literal("admin") }),
]);

export type Authorization = {
  principal: Principal;
  reach: Reach;
  /** Null only for the configured administrator credential. */
  grant: AccessGrant | null;
};

/** The provider validates clients, redirects and PKCE. We own the finite set of
 * resources this authorization server may grant; omission never creates an unbound token. */
export async function parseAuthorization(env: Env, request: Request): Promise<AuthRequest> {
  const addresses = platformAddressesOf(env, request);
  const auth = await oauthHelpers(env, addresses).parseAuthRequest(request);
  const { api, mcp } = addresses;
  const resources = [...new Set(auth.resource ? [auth.resource].flat() : [])];
  if (
    !resources.length ||
    resources.some(
      (resource) =>
        !URL.canParse(resource) ||
        ![api, mcp].some((allowed) => new URL(resource).href === new URL(allowed).href),
    )
  )
    throw new AuthorizationError("invalid_target", {
      description: "Choose an advertised iterate API resource.",
      redirectUri: auth.redirectUri,
      state: auth.state,
      issuer: auth.issuer,
    });
  const scopes = OAuthScopes.safeParse(auth.scope);
  if (!scopes.success)
    throw new AuthorizationError("invalid_scope", {
      description: "This API supports iterate and account scopes.",
      redirectUri: auth.redirectUri,
      state: auth.state,
      issuer: auth.issuer,
    });
  return { ...auth, scope: scopes.data, resource: resources };
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

/** A fresh read of the account on each admission — never memoized: provider KV expiry/deletion
 * alone cannot deny a token during propagation or a refresh racing with logout, and a memo here
 * would let a revoked grant through for its life. (The live socket's 30 s re-check, rpc.ts, is
 * the one lag anywhere.) */
export async function authorizationOf(env: Env, props: unknown): Promise<Authorization | null> {
  const parsed = AccessProps.safeParse(props);
  if (!parsed.success) return null;
  if (parsed.data.kind === "admin")
    return { principal: { actor: "admin" }, reach: "every", grant: null };
  const grant = parsed.data;
  if (
    grant.expiresAt <= Date.now() ||
    !grant.scope.includes("iterate") ||
    grant.deadline <= Date.now() ||
    (await grantIsRevoked(env, grant.userId, grant.grantId))
  )
    return null;
  return {
    principal: { actor: grant.userId, email: grant.email },
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `reach` is discriminated with `"projectIds" in reach` (session.ts, control-plane/edge.ts) and TS narrows on that key, so a present-but-undefined key would both misread as a bound grant and break the narrowing; the conditional spread stays (grant.projects is string[] | null)
    reach: { userId: grant.userId, ...(grant.projects && { projectIds: grant.projects }) },
    grant,
  };
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

/** One provider configuration owns issuance and both resource protocols. No global
 * resource pin: the provider supports audience arrays and downscoping itself.
 * parseAuthorization is the only public consent path and requires allowed resources. */
function providerOptions(
  env: Env,
  { platformOrigin: issuer, api, mcp }: PlatformAddresses,
  apiHandler: Handler,
  defaultHandler: Handler,
): OAuthProviderOptions<Env> {
  // The provider hands its handlers the env it runs over (`providerEnv`); they run over the
  // worker's own.
  const onWorkerEnv = (handler: Handler): Handler => ({
    fetch: (request, _providerEnv, ctx) => handler.fetch(request, env, ctx),
  });
  return {
    apiHandlers: { [api]: onWorkerEnv(apiHandler), [mcp]: onWorkerEnv(apiHandler) },
    defaultHandler: onWorkerEnv(defaultHandler),
    authorizeEndpoint: `${issuer}/oauth2/auth`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    // DCR is served on every deployment (not just local http): CIMD stays the apps' own path
    // (iterate/app-session.ts uses a client-id metadata document), but standard MCP clients (the MCP
    // Inspector, Claude's connector) require dynamic registration, so the endpoint is always published.
    clientRegistrationEndpoint: `${issuer}/oauth2/register`,
    scopesSupported: OAuthScope.options,
    // The provider's own protected-resource metadata endpoint never runs (api.ts answers
    // `/.well-known/oauth-protected-resource*` first), but this list is the `scope=` of every 401
    // challenge on `/api` and `/mcp`: the minimum permission; account is explicit opt-in.
    resourceMetadata: { scopes_supported: ["iterate"] },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    async resolveExternalToken({ token }) {
      if (!(await verifyAdminSecret(token, appConfigOf(env).secrets.adminBearer.exposeSecret())))
        return null;
      return { props: { kind: "admin" }, audience: [api, mcp] };
    },
    async tokenExchangeCallback(input) {
      const parsed = GrantProps.safeParse(input.props);
      if (
        !parsed.success ||
        parsed.data.userId !== input.userId ||
        (await grantIsRevoked(env, input.userId, input.grantId))
      )
        throw new OAuthError("invalid_grant", { description: "The session is no longer active." });
      const grant = parsed.data;
      if (grant.deadline - Date.now() < 60_000)
        throw new OAuthError("invalid_grant", { description: "The session has expired." });
      if (grant.kind === "personal" && input.grantType !== "authorization_code")
        throw new OAuthError("invalid_grant", { description: "Personal tokens cannot refresh." });
      // A personal token lives until its deadline (30 days by default, up to ten years for a
      // device — grants.ts `mint`); an interactive session's token is renewed hourly.
      const accessTokenTTL =
        grant.kind === "personal"
          ? Math.floor((grant.deadline - Date.now()) / 1000)
          : Math.min(3600, Math.floor((grant.deadline - Date.now()) / 1000));
      return {
        accessTokenTTL,
        accessTokenProps: {
          ...grant,
          grantId: input.grantId,
          scope: input.requestedScope,
          expiresAt: Math.floor(Date.now() / 1000) * 1000 + accessTokenTTL * 1000,
        } satisfies AccessGrant,
        // The key MUST be absent on refresh, including when its value is undefined.
        ...(input.grantType === "authorization_code" &&
          grant.kind === "personal" && { refreshTokenTTL: accessTokenTTL }),
      };
    },
  };
}

/** The env the provider runs over: the worker's, with `OAUTH_KV` the provider's store
 *  (oauth-store.ts), whose grants live in the control plane. */
const providerEnv = (env: Env): Env => ({ ...env, OAUTH_KV: providerStore(env) });

export function oauthHelpers(env: Env, addresses: PlatformAddresses) {
  return getOAuthApi(providerOptions(env, addresses, notFound, notFound), providerEnv(env));
}

/** A request through the provider: its endpoints, then `apiHandler` for a request to `/api` or
 *  `/mcp` bearing a token it admits, and `defaultHandler` for everything else. */
export function providerFetch(
  env: Env,
  addresses: PlatformAddresses,
  request: Request,
  ctx: ExecutionContext,
  {
    apiHandler = notFound,
    defaultHandler = notFound,
  }: { apiHandler?: Handler; defaultHandler?: Handler } = {},
): Promise<Response> {
  return new OAuthProvider(providerOptions(env, addresses, apiHandler, defaultHandler)).fetch(
    request,
    providerEnv(env),
    ctx,
  );
}

/** The browser adapter asks the same provider gate to admit its server-held token
 * at the API resource. No public validation endpoint or second token verifier. */
export async function authorizationForToken(
  env: Env,
  ctx: ExecutionContext,
  token: string,
  addresses: PlatformAddresses,
) {
  let authorization: Authorization | null = null;
  const admission: Handler = {
    async fetch(_request, bindings, context) {
      authorization = await authorizationOf(bindings, context.props);
      return new Response(null, { status: authorization ? 204 : 401 });
    },
  };
  const apiRequest = new Request(addresses.api, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const response = await providerFetch(env, addresses, apiRequest, ctx, { apiHandler: admission });
  if (response.status !== 204 && response.status !== 401)
    throw new Error(`Token admission failed (${response.status})`);
  return authorization as Authorization | null; // Assigned inside the awaited handler; TS cannot track that closure assignment.
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

const notFound: Handler = { fetch: () => new Response("Not found", { status: 404 }) };
