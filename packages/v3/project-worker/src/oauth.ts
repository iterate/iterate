import {
  AuthorizationError,
  OAuthError,
  OAuthProvider,
  getOAuthApi,
  type AuthRequest,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { Env, Handler } from "./control-plane.ts";
import { type Reach } from "./directory.ts";
import { verifyAdminSecret, type Principal } from "./principal.ts";
import { appConfigOf } from "./app-config.ts";

/** Encrypted by the provider. Every grant is created through parseAuthorization,
 * so this version also proves the grant has a nonempty, allowed resource audience. */
export const GrantProps = z.object({
  kind: z.literal("user-grant"),
  version: z.literal(1),
  userId: z.string().startsWith("user_"),
  email: z.string(),
  projects: z.array(z.string()).nullable(),
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

/** Canonical resource identifiers, including the MCP root's explicit slash. */
export function oauthAddresses(env: Env) {
  const config = appConfigOf(env);
  const issuer = config.platformOrigin;
  return {
    issuer,
    api: `${issuer}/api`,
    mcp: config.mcpOrigin ? `${config.mcpOrigin}/` : `${issuer}/mcp`,
  };
}

/** The provider validates clients, redirects and PKCE. We own the finite set of
 * resources this authorization server may grant; omission never creates an unbound token. */
export async function parseAuthorization(env: Env, request: Request): Promise<AuthRequest> {
  const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const { api, mcp } = oauthAddresses(env);
  const resources = [...new Set(auth.resource ? [auth.resource].flat() : [])];
  if (
    !resources.length ||
    resources.some(
      (resource) => ![api, mcp].some((allowed) => new URL(resource).href === new URL(allowed).href),
    )
  )
    throw new AuthorizationError("invalid_target", {
      description: "Choose an advertised Iterate API resource.",
      redirectUri: auth.redirectUri,
      state: auth.state,
      issuer: auth.issuer,
    });
  if (auth.scope.length && !auth.scope.includes("iterate"))
    throw new AuthorizationError("invalid_scope", {
      description: "This API requires the iterate scope.",
      redirectUri: auth.redirectUri,
      state: auth.state,
      issuer: auth.issuer,
    });
  return { ...auth, scope: ["iterate"], resource: resources };
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

/** One provider configuration owns issuance and both resource protocols. No global
 * resource pin: the provider supports audience arrays and downscoping itself.
 * parseAuthorization is the only public consent path and requires allowed resources. */
export function providerOptions(
  env: Env,
  apiHandler: Handler = notFound,
  defaultHandler: Handler = notFound,
): OAuthProviderOptions<Env> {
  const { issuer, api, mcp } = oauthAddresses(env);
  return {
    apiHandlers: { [api]: apiHandler, [mcp]: apiHandler },
    defaultHandler,
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
      if (grant.deadline && grant.deadline - Date.now() < 60_000)
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

export function oauthHelpers(env: Env) {
  return getOAuthApi(providerOptions(env), env);
}

/** The same code/PKCE parameters for browser login and a console-minted token. */
export async function authorizationCodeRequest(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  resources: string[];
}) {
  const verifier =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const state = crypto.randomUUID();
  const url = new URL("/authorize", input.issuer);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: "iterate",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  for (const resource of input.resources) url.searchParams.append("resource", resource);
  return { url, state, verifier };
}

/** The browser adapter asks the same provider gate to admit its server-held token
 * at the API resource. No public validation endpoint or second token verifier. */
export async function authorizationForToken(env: Env, ctx: ExecutionContext, token: string) {
  let authorization: Authorization | null = null;
  const admission: Handler = {
    async fetch(_request, bindings, context) {
      authorization = await authorizationOf(bindings, context.props);
      return new Response(null, { status: authorization ? 204 : 401 });
    },
  };
  const apiRequest = new Request(oauthAddresses(env).api, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new OAuthProvider(providerOptions(env, admission)).fetch(apiRequest, env, ctx);
  return authorization as Authorization | null; // Assigned inside the awaited handler; TS cannot track that closure assignment.
}

/** The caller must already own this grant: a checked provider inventory row or
 * the BrowserSession's stored token summary. The D1 marker precedes KV cleanup. */
export async function revokeGrant(env: Env, grant: { userId: string; grantId: string }) {
  await env.DB.prepare(`INSERT INTO oauth_activity (user_id, grant_id, revoked_at, cleanup_pending)
VALUES (?, ?, ?, 1) ON CONFLICT(user_id, grant_id) DO UPDATE
SET revoked_at = COALESCE(oauth_activity.revoked_at, excluded.revoked_at), cleanup_pending = 1`)
    .bind(grant.userId, grant.grantId, Date.now())
    .run();
  try {
    await oauthHelpers(env).revokeGrant(grant.grantId, grant.userId);
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

/** In-process token exchange, also used by the browser session DO. */
export function exchangeToken(request: Request, env: Env, ctx: ExecutionContext) {
  return new OAuthProvider(providerOptions(env)).fetch(request, env, ctx);
}
