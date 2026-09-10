import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env, Handler } from "./control-plane.ts";
import { authorizationOf, recordGrantUse, oauthAddresses, providerOptions } from "./oauth.ts";
import { rpcResponse } from "./rpc.ts";
import { mcpResponse } from "./mcp.ts";

export const protectedApi: Handler = {
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

export function oauthResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  defaultHandler?: Handler,
) {
  const url = new URL(request.url);
  const { issuer, api, mcp } = oauthAddresses(env);
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
  return new OAuthProvider(providerOptions(env, protectedApi, defaultHandler)).fetch(
    request,
    env,
    ctx,
  );
}
