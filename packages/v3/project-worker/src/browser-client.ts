import { oauthResponse } from "./api.ts";
import type { Env } from "./control-plane.ts";
import { authorizationForToken, oauthAddresses, type Authorization } from "./oauth.ts";
import { cookieValueOf } from "./principal.ts";
import { isSameOriginBrowserRequest } from "./lib.ts";
import { sameOriginPath } from "./lib.ts";

/** Include the local port: cookies are host-scoped, while a dev session is
 * origin-scoped. All platform cookies are stripped before userspace sees a request. */
function sessionCookieName(url: URL) {
  return `__Host-itx-session${url.port ? `-${url.port}` : ""}`;
}
function sessionFor(env: Env, request: Request) {
  const url = new URL(request.url);
  const id = cookieValueOf(request.headers.get("cookie"), sessionCookieName(url));
  if (!id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) return null;
  return env.BROWSER_SESSION.getByName(`${url.origin}:${id}`);
}

export function appCookies(cookie: string | null) {
  return (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("__Host-itx-"))
    .join("; ");
}

/** The identity of a browser request, through the same gate as a header bearer.
 * Rendering a page never exposes the opaque cookie, access token or refresh token. */
export async function browserAuthorization(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<Authorization | null> {
  const session = sessionFor(env, request);
  const token = await session?.bearer();
  if (!token) return null;
  const authorization = await authorizationForToken(env, request, ctx, token);
  if (!authorization) await session!.end();
  return authorization;
}

/** One adapter for the console and every project app. The edge calls this only
 * after checking the configured origin or resolving the project in its directory. */
export async function browserClient(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  projectId: string | null,
) {
  const url = new URL(request.url);
  const { issuer, api } = oauthAddresses(env, request);
  if (url.pathname === "/.auth/client.json") {
    return Response.json(
      {
        client_id: `${url.origin}/.auth/client.json`,
        client_name: url.host,
        redirect_uris: [`${url.origin}/.auth/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  }
  if (url.pathname === "/.auth/login") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const id = crypto.randomUUID();
    const session = env.BROWSER_SESSION.getByName(`${url.origin}:${id}`);
    const location = await session.begin(
      { origin: url.origin, issuer, resource: api, projectId },
      sameOriginPath(url.searchParams.get("next") || "/", url.origin),
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Set-Cookie": `${sessionCookieName(url)}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (url.pathname === "/.auth/callback") {
    const session = sessionFor(env, request);
    const result = await session?.complete({
      state: url.searchParams.get("state") || "",
      issuer: url.searchParams.get("iss") || "",
      code: url.searchParams.get("code") || "",
      error: url.searchParams.get("error") || "",
    });
    if (!result || result.error)
      return new Response(result?.error || "Sign-in does not match this browser.", {
        status: 400,
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    return new Response(null, {
      status: 303,
      headers: {
        Location: result.next!,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (url.pathname === "/.auth/logout") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!isSameOriginBrowserRequest(request))
      return new Response("Cross-site request refused", { status: 403 });
    await sessionFor(env, request)?.end();
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${sessionCookieName(url)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (url.pathname === "/api") {
    let token = request.headers.get("authorization");
    if (!token && request.method !== "OPTIONS") {
      const session = sessionFor(env, request);
      if (session && request.headers.get("origin") !== url.origin)
        return new Response("A browser API request must have the same origin", { status: 403 });
      const bearer = await session?.bearer();
      if (bearer) token = `Bearer ${bearer}`;
    }
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") headers.delete("origin"); // Preserve a 101: provider CORS wrapping reconstructs Responses.
    if (token) headers.set("authorization", token);
    return oauthResponse(new Request(api, new Request(request, { headers })), env, ctx);
  }
  if (url.pathname.startsWith("/.auth/")) return new Response("Not found", { status: 404 });
  return null;
}
