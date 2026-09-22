import {
  AuthorizationError,
  OAuthError,
  OAuthProvider,
  getOAuthApi,
  type AuthRequest,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { OAuthScope, OAuthScopes } from "iterate/next/oauth-scopes";
import { verifyAdminSecret, type Principal } from "iterate/next/principal";
import type { Env, Handler } from "./control-plane.ts";
import { type Reach } from "./directory.ts";
import { appConfigOf, platformOriginOf } from "./app-config.ts";

/** Encrypted by the provider. Every grant is created through parseAuthorization,
 * so this version also proves the grant has a nonempty, allowed resource audience. */
export const GrantProps = z.object({
  kind: z.enum(["issuer", "app", "personal"]),
  version: z.literal(2),
  userId: z.string().startsWith("user_"),
  email: z.string(),
  /** the identity provider's picture and display name of the person (when the provider supplies them), shown where the
   *  grant's session is — the consent page's "signed in as"; the name seeds the onboarding step's
   *  organization name */
  picture: z.string().optional(),
  name: z.string().optional(),
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

/** Canonical resource identifiers, including the MCP root's explicit slash, at `platformOrigin` —
 *  the issuer (app-config.ts `platformOriginOf`: what the request in hand reached the platform on;
 *  a session carries it as `SessionInput.platformOrigin`). */
export function oauthAddresses(env: Env, platformOrigin: string) {
  const config = appConfigOf(env);
  const issuer = platformOrigin;
  return {
    issuer,
    api: `${issuer}/api`,
    mcp: config.urls.mcp ? `${config.urls.mcp}/` : `${issuer}/mcp`,
  };
}

/** The provider validates clients, redirects and PKCE. We own the finite set of
 * resources this authorization server may grant; omission never creates an unbound token. */
export async function parseAuthorization(env: Env, request: Request): Promise<AuthRequest> {
  const platformOrigin = platformOriginOf(appConfigOf(env), request);
  const auth = await oauthHelpers(env, platformOrigin).parseAuthRequest(request);
  const { api, mcp } = oauthAddresses(env, platformOrigin);
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
      description: "Choose an advertised Iterate API resource.",
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

async function grantIsRevoked(env: Env, userId: string, grantId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT revoked_at FROM oauth_activity WHERE user_id = ? AND grant_id = ?",
  )
    .bind(userId, grantId)
    .first<{ revoked_at: number | null }>();
  return Boolean(row?.revoked_at);
}

/** Fresh primary D1 read on each admission. Provider KV expiry/deletion alone
 * cannot deny a token during propagation or a refresh racing with logout. */
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
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `reach` is discriminated with `"projectIds" in reach` (session.ts, directory.ts) and TS narrows on that key, so a present-but-undefined key would both misread as a bound grant and break the narrowing; the conditional spread stays (grant.projects is string[] | null)
    reach: { userId: grant.userId, ...(grant.projects && { projectIds: grant.projects }) },
    // The issuer's own session is the person at the issuer, not a consent: it holds every scope,
    // whatever list it was minted with — a cookie from before a scope existed still creates
    // organizations on the consent page.
    grant:
      grant.kind === "issuer"
        ? { ...grant, scope: ["iterate", "account", "organizations:write"] }
        : grant,
  };
}

export async function recordGrantUse(env: Env, grant: AccessGrant): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO oauth_activity (user_id, grant_id, last_used_at)
VALUES (?, ?, ?) ON CONFLICT(user_id, grant_id) DO UPDATE
SET last_used_at = MAX(COALESCE(oauth_activity.last_used_at, 0), excluded.last_used_at)
WHERE oauth_activity.last_used_at IS NULL OR oauth_activity.last_used_at < ?`)
    .bind(grant.userId, grant.grantId, now, now - 60_000)
    .run();
}

/** One provider configuration owns issuance and both resource protocols. No global
 * resource pin: the provider supports audience arrays and downscoping itself.
 * parseAuthorization is the only public consent path and requires allowed resources. */
export function providerOptions(
  env: Env,
  platformOrigin: string,
  apiHandler: Handler = notFound,
  defaultHandler: Handler = notFound,
): OAuthProviderOptions<Env> {
  const { issuer, api, mcp } = oauthAddresses(env, platformOrigin);
  return {
    apiHandlers: { [api]: apiHandler, [mcp]: apiHandler },
    defaultHandler,
    authorizeEndpoint: `${issuer}/oauth2/auth`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    // DCR is served on every deployment (not just local http): CIMD stays the console's own path
    // (browser-session.ts uses a client-id metadata document), but standard MCP clients (the MCP
    // Inspector, Claude's connector) require dynamic registration, so the endpoint is always published.
    clientRegistrationEndpoint: `${issuer}/oauth2/register`,
    scopesSupported: OAuthScope.options,
    resourceMetadata: {
      ...(issuer.startsWith("https:") && { authorization_servers: [issuer] }),
      // Initial challenges request the minimum permission; account is explicit opt-in.
      scopes_supported: ["iterate"],
    },
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

export function oauthHelpers(env: Env, platformOrigin: string) {
  return getOAuthApi(providerOptions(env, platformOrigin), env);
}

/** The browser adapter asks the same provider gate to admit its server-held token
 * at the API resource. No public validation endpoint or second token verifier. */
export async function authorizationForToken(
  env: Env,
  ctx: ExecutionContext,
  token: string,
  platformOrigin: string,
) {
  let authorization: Authorization | null = null;
  const admission: Handler = {
    async fetch(_request, bindings, context) {
      authorization = await authorizationOf(bindings, context.props);
      return new Response(null, { status: authorization ? 204 : 401 });
    },
  };
  const apiRequest = new Request(oauthAddresses(env, platformOrigin).api, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const response = await new OAuthProvider(providerOptions(env, platformOrigin, admission)).fetch(
    apiRequest,
    env,
    ctx,
  );
  if (response.status !== 204 && response.status !== 401)
    throw new Error(`Token admission failed (${response.status})`);
  return authorization as Authorization | null; // Assigned inside the awaited handler; TS cannot track that closure assignment.
}

/** The caller must already own this grant: a checked provider inventory row or
 * the authenticated request's grant. The D1 marker precedes KV cleanup. */
export async function revokeGrant(
  env: Env,
  platformOrigin: string,
  grant: { userId: string; grantId: string },
) {
  await env.DB.prepare(`INSERT INTO oauth_activity (user_id, grant_id, revoked_at, cleanup_pending)
VALUES (?, ?, ?, 1) ON CONFLICT(user_id, grant_id) DO UPDATE
SET revoked_at = COALESCE(oauth_activity.revoked_at, excluded.revoked_at), cleanup_pending = 1`)
    .bind(grant.userId, grant.grantId, Date.now())
    .run();
  try {
    await oauthHelpers(env, platformOrigin).revokeGrant(grant.grantId, grant.userId);
  } catch (error) {
    console.error("oauth.revoke_cleanup_failed", {
      userId: grant.userId,
      grantId: grant.grantId,
      error,
    });
    return { cleanupPending: true };
  }
  await env.DB.prepare(
    "UPDATE oauth_activity SET cleanup_pending = 0 WHERE user_id = ? AND grant_id = ?",
  )
    .bind(grant.userId, grant.grantId)
    .run();
  return { cleanupPending: false };
}

const notFound: Handler = { fetch: () => new Response("Not found", { status: 404 }) };

/** Completed revocation markers are kept a day past the thirty days an interactive grant can
 * last; a personal token may live years (grants.ts `mint`), but revoking one deletes its provider
 * rows outright, so the marker is not what denies it. Failed cleanup stays visible. Each hourly
 * cron does at most one thousand deletes. */
export async function cleanGrantActivity(env: Env) {
  const cutoff = Date.now() - 31 * 24 * 3600_000;
  const result = await env.DB.prepare(`DELETE FROM oauth_activity WHERE rowid IN (
SELECT rowid FROM oauth_activity WHERE cleanup_pending = 0
AND COALESCE(last_used_at, 0) < ? AND COALESCE(revoked_at, 0) < ? LIMIT 1000)`)
    .bind(cutoff, cutoff)
    .run();
  console.info("oauth.activity_cleanup", { deleted: result.meta.changes });
}
