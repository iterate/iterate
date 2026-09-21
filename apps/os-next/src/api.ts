import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { OAuthScope } from "iterate/next/oauth-scopes";
import type { Env, Handler } from "./control-plane.ts";
import { authorizationOf, recordGrantUse, oauthAddresses, providerOptions } from "./oauth.ts";
import { rpcResponse } from "./rpc.ts";
import { mcpResponse } from "./mcp.ts";

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

export function oauthResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  defaultHandler?: Handler,
) {
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
      scopes_supported: resource === mcp ? ["iterate"] : OAuthScope.options,
      bearer_methods_supported: ["header"],
    });
  }
  // THE BARE SOCKET: a capnweb client with no credential on the upgrade — a static page on another
  // origin, whose browser cannot put a bearer on a WebSocket — opens the transport empty and presents
  // its token IN-BAND, `authenticate({ type: "bearer", token })` (capnweb's own pattern; session.ts,
  // bound to the socket by rpc.ts). Empty = the root and nothing else: no capability until that call
  // resolves through the same gate the header goes through. The HTTP form stays behind the gate —
  // the console's sign-in probe (iterate/next/app) reads its 401.
  if (
    url.pathname === "/api" &&
    !request.headers.has("authorization") &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  )
    return rpcResponse(request, env, ctx, null);
  return new OAuthProvider(providerOptions(env, protectedApi, defaultHandler)).fetch(
    request,
    env,
    ctx,
  );
}
