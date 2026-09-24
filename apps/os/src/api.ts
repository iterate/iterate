import { insufficientScope, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { reportIssue } from "iterate/lib";
import { platformAddressesOf, type PlatformAddresses } from "./app-config.ts";
import type { Env, Handler } from "./env.ts";
import {
  authorizationServerFetch,
  recordGrantUse,
  validateToken,
  type Authorization,
} from "./oauth.ts";
import { rpcResponse } from "./rpc.ts";
import { mcpResponse } from "./mcp.ts";

/** The authorization server's own endpoints (oauth.ts), on the platform origin. */
const AUTHORIZATION_SERVER_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/oauth2/token",
  "/oauth2/register",
]);

/** THE PLATFORM'S OAUTH ROUTES: `/api` and `/mcp`, each a protected resource of the authorization
 *  server hosted here (the library's `OAuthResourceServer`, which publishes the resource's RFC 9728
 *  metadata, challenges a request without a token, and validates one for its own resource alone);
 *  the authorization server's own endpoints; and everything else to `defaultHandler`. The
 *  library's docs/resource-servers.md: "You own routing". */
export function oauthResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  defaultHandler: Handler = notFound,
) {
  const url = new URL(request.url);
  const addresses = platformAddressesOf(env, request);
  // THE BARE SOCKET: a capnweb client with no credential on the upgrade — a static page on another
  // origin, whose browser cannot put a bearer on a WebSocket — opens the transport empty and presents
  // its token IN-BAND, `authenticate({ type: "bearer", token })` (capnweb's own pattern; session.ts,
  // bound to the socket by rpc.ts). Empty = the root and nothing else: no capability until that call
  // resolves through the same gate the header goes through. The HTTP form stays behind the gate —
  // an app's sign-in probe (iterate/app) reads its 401.
  if (
    url.pathname === "/api" &&
    !request.headers.has("authorization") &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  )
    return rpcResponse(request, env, ctx, null);
  if (isResourceRequest(addresses.api, url))
    return resourceServer(addresses, addresses.api, rpcResponse).fetch(request, env, ctx);
  if (isResourceRequest(addresses.mcp, url))
    return resourceServer(addresses, addresses.mcp, (request, env, _ctx, authorization) =>
      mcpResponse(request, env, authorization),
    ).fetch(request, env, ctx);
  if (url.origin === addresses.platformOrigin && AUTHORIZATION_SERVER_PATHS.has(url.pathname))
    return authorizationServerFetch(env, addresses, request, ctx);
  return defaultHandler.fetch(request, env, ctx);
}

/** One of the platform's resources, hosted with oauth.ts's validator: `serve` gets the bearer's
 *  authorization (`ctx.props`) once its token holds `iterate` — one that lacks it is answered with
 *  the MCP step-up challenge (`insufficientScope`). The first scope a client asks for is
 *  `iterate` alone (`scopes_supported`, the initial 401's `scope`): `account` and
 *  `organizations:write` are the client's explicit choice. */
function resourceServer(
  addresses: PlatformAddresses,
  resource: string,
  serve: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    authorization: Authorization,
  ) => Promise<Response>,
) {
  return new OAuthResourceServer<Env, Authorization>({
    resourceMetadata: {
      resource,
      authorization_servers: [addresses.platformOrigin],
      scopes_supported: ["iterate"],
    },
    // The library calls it with this server's own canonical resource, and answers a throw with a
    // bare 503 that names no cause: the cause is reported here.
    validateToken: (env) => async (canonical, token) => {
      try {
        return await validateToken(env, addresses, canonical, token);
      } catch (error) {
        reportIssue("oauth.token-validation-failed", error, { resource: canonical });
        throw error;
      }
    },
    handler: {
      fetch(request, env, ctx) {
        if (!ctx.auth.scope.includes("iterate")) return insufficientScope(ctx.auth, ["iterate"]);
        if (ctx.props.grant) ctx.waitUntil(recordGrantUse(env, ctx.props.grant));
        return serve(request, env, ctx, ctx.props);
      },
    },
  });
}

/** Whether `url` is `resource`'s: the resource itself, a path below it, or its RFC 9728 metadata
 *  document — what its `OAuthResourceServer` answers. */
function isResourceRequest(resource: string, url: URL) {
  const { origin, pathname } = new URL(resource);
  if (url.origin !== origin) return false;
  if (url.pathname.startsWith("/.well-known/"))
    return (
      url.pathname === `/.well-known/oauth-protected-resource${pathname === "/" ? "" : pathname}`
    );
  return pathname === "/" || url.pathname === pathname || url.pathname.startsWith(`${pathname}/`);
}

const notFound: Handler = { fetch: () => new Response("Not found", { status: 404 }) };
