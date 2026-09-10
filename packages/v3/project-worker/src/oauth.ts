import {
  AuthorizationError,
  OAuthError,
  OAuthProvider,
  getOAuthApi,
  type AuthRequest,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { consoleHandler, type Env, type Handler } from "./control-plane.ts";
import { type Reach } from "./directory.ts";
import { mcpResponse } from "./mcp.ts";
import { verifyAdminSecret, type Principal } from "./principal.ts";
import { rpcResponse } from "./rpc.ts";
import { appConfigOf } from "./worker.ts";

/** Encrypted by the provider. Every grant is created through parseAuthorization,
 * so this version also proves the grant has a nonempty, allowed resource audience. */
export const GrantProps = z.object({
  kind: z.literal("user-grant"),
  version: z.literal(1),
  userId: z.string().startsWith("user_"),
  email: z.string(),
  projects: z.array(z.string()).nullable(),
  resources: z.array(z.string()).min(1),
  tokenKind: z.enum(["oauth", "personal", "device"]),
  deadline: z.number().int().positive().nullable(),
});
export type GrantProps = z.infer<typeof GrantProps>;

const AccessGrant = GrantProps.extend({
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

/** Canonical resource identifiers. The MCP origin intentionally has no trailing
 * slash, matching its public protected-resource metadata. */
export function oauthAddresses(env: Env, request: Request) {
  const config = appConfigOf(env);
  const issuer = config.platformOrigin || new URL(request.url).origin;
  return { issuer, api: `${issuer}/api`, mcp: config.mcpOrigin || `${issuer}/mcp` };
}

/** The provider validates clients, redirects and PKCE. We own the finite set of
 * resources this authorization server may grant; omission never creates an unbound token. */
export async function parseAuthorization(env: Env, request: Request): Promise<AuthRequest> {
  const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const { api, mcp } = oauthAddresses(env, request);
  const resources = [...new Set(auth.resource ? [auth.resource].flat() : [])];
  if (!resources.length || resources.some((resource) => resource !== api && resource !== mcp))
    throw new AuthorizationError("invalid_target", {
      description: "Choose an advertised Iterate API resource.",
      redirectUri: auth.redirectUri,
      state: auth.state,
      issuer: auth.issuer,
    });
  return { ...auth, resource: resources };
}

export async function grantIsRevoked(env: Env, userId: string, grantId: string): Promise<boolean> {
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
    (grant.deadline && grant.deadline <= Date.now()) ||
    (await grantIsRevoked(env, grant.userId, grant.grantId))
  )
    return null;
  return {
    principal: { actor: grant.userId, email: grant.email },
    reach: { userId: grant.userId, ...(grant.projects && { projectIds: grant.projects }) },
    grant,
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

const protectedApi: Handler = {
  async fetch(request, env, ctx) {
    const authorization = await authorizationOf(env, ctx.props);
    if (!authorization)
      return new Response("Invalid or revoked session", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      });
    if (authorization.grant) ctx.waitUntil(recordGrantUse(env, authorization.grant));
    return new URL(request.url).pathname === "/api"
      ? rpcResponse(request, env, ctx, authorization)
      : mcpResponse(request, env, authorization);
  },
};

/** One provider configuration owns issuance and both resource protocols. No global
 * resource pin: the provider supports audience arrays and downscoping itself.
 * parseAuthorization is the only public consent path and requires allowed resources. */
function providerOptions(env: Env, request: Request): OAuthProviderOptions<Env> {
  const { issuer, api, mcp } = oauthAddresses(env, request);
  return {
    apiHandlers: { [api]: protectedApi, [mcp]: protectedApi },
    defaultHandler: consoleHandler,
    authorizeEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    scopesSupported: ["iterate"],
    resourceMetadata: {
      ...(issuer.startsWith("https:") && { authorization_servers: [issuer] }),
      scopes_supported: ["iterate"],
    },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    async resolveExternalToken({ token }) {
      if (!(await verifyAdminSecret(token, appConfigOf(env).adminApiSecret))) return null;
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
      if (grant.deadline && grant.deadline <= Date.now())
        throw new OAuthError("invalid_grant", { description: "The session has expired." });
      if (grant.tokenKind === "personal" && input.grantType !== "authorization_code")
        throw new OAuthError("invalid_grant", { description: "Personal tokens cannot refresh." });
      const ttl = grant.tokenKind === "personal" ? 30 * 24 * 3600 : 3600;
      const accessTokenTTL = grant.deadline
        ? Math.min(ttl, Math.floor((grant.deadline - Date.now()) / 1000))
        : ttl;
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
          grant.tokenKind === "personal" && { refreshTokenTTL: 0 }),
        ...(input.grantType === "authorization_code" &&
          grant.tokenKind === "device" && { refreshTokenTTL: undefined }),
      };
    },
  };
}

export function oauthHelpers(env: Env, request: Request) {
  return getOAuthApi(providerOptions(env, request), env);
}

export const oauth: Handler = {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { issuer, api, mcp } = oauthAddresses(env, request);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      const resource =
        url.origin === new URL(mcp).origin && mcp !== `${issuer}/mcp`
          ? mcp
          : url.pathname.endsWith("/mcp")
            ? mcp
            : api;
      return Response.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["iterate"],
        bearer_methods_supported: ["header"],
      });
    }
    // Public registration is disabled; it must not fall through to a console route.
    if (url.pathname === "/oauth/register") return new Response("Not found", { status: 404 });
    return new OAuthProvider(providerOptions(env, request)).fetch(request, env, ctx);
  },
};
