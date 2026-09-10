import type { BrowserHost, BrowserSession } from "../browser-session.ts";
import { cookieValueOf } from "../principal.ts";
import { isSameOriginBrowserRequest, sameOriginPath } from "../lib.ts";
import { OAuthScopes } from "../oauth-scopes.ts";

/** The port separates local apps sharing localhost's cookie jar. */
function sessionCookieName(url: URL) {
  return `__Host-itx-session${url.port ? `-${url.port}` : ""}`;
}
export function appSession(namespace: DurableObjectNamespace<BrowserSession>, request: Request) {
  const url = new URL(request.url);
  const id = cookieValueOf(request.headers.get("cookie"), sessionCookieName(url));
  return id && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
    ? namespace.getByName(`${url.origin}:${id}`)
    : null;
}

/** Start one ordinary app session; the caller publishes its cookie after its own
 * sign-in step succeeds. The issuer uses this same code/PKCE flow internally. */
export async function startAppSession(
  sessions: DurableObjectNamespace<BrowserSession>,
  host: BrowserHost,
  next: string,
) {
  const id = crypto.randomUUID();
  const session = sessions.getByName(`${host.origin}:${id}`);
  const location = await session.begin(host, next);
  const setCookie = `${sessionCookieName(new URL(host.origin))}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
  return { session, location, setCookie };
}

type AppAuth = {
  sessions: DurableObjectNamespace<BrowserSession>;
  issuer: string;
  resource: string;
  /** Default request; any supported account permission still requires issuer consent. */
  defaultScopes?: string[];
  /** Platform dispatches in process to avoid /api recursion; other apps pass fetch. */
  api: (request: Request) => Promise<Response> | Response;
  /** The issuer proves identity before establishing its own ordinary app session. */
  loginPage?: string;
};

/** The same OAuth client and /api proxy on a platform host or a separate app worker. */
export async function appAuth(request: Request, config: AppAuth): Promise<Response | null> {
  const url = new URL(request.url);
  const { issuer, resource, sessions } = config;
  const session = appSession(sessions, request);
  const clearCookie = `${sessionCookieName(url)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  if (url.pathname === "/.auth/client.json")
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

  if (url.pathname === "/.auth/login") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const next = sameOriginPath(url.searchParams.get("next") || "/", url.origin);
    const parsed = OAuthScopes.safeParse(
      url.searchParams.has("scope")
        ? url.searchParams.get("scope")!.split(" ").filter(Boolean)
        : (config.defaultScopes ?? []),
    );
    if (!parsed.success) return new Response("Unsupported permission", { status: 400 });
    const scopes = parsed.data;
    const bearer = await session?.bearer();
    if (bearer) {
      const probe = await config.api(
        new Request(resource, {
          method: "POST",
          body: "",
          headers: { Authorization: `Bearer ${bearer}` },
        }),
      );
      await probe.body?.cancel();
      if (probe.status !== 401) {
        if (!probe.ok) throw new Error(`Iterate API check failed (${probe.status})`);
        const heldScopes = await session!.scopes();
        if (scopes.every((scope) => heldScopes.includes(scope)))
          return new Response(null, {
            status: 303,
            headers: { Location: next, "Cache-Control": "no-store" },
          });
        // Only a deliberate POST can replace a valid grant. GET never signs out.
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Update permissions</title><h1>Update app permissions</h1><p>This app needs additional permissions. Continue to sign in and review them.</p><form method="post" action="/.auth/logout?next=${encodeURIComponent(url.pathname + url.search)}"><button type="submit">Continue</button></form></html>`,
          {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          },
        );
      }
      await session!.discard();
    }
    if (config.loginPage)
      return new Response(null, {
        status: 303,
        headers: {
          Location: `${config.loginPage}?${new URLSearchParams({ next })}`,
          "Cache-Control": "no-store",
        },
      });
    const { location, setCookie } = await startAppSession(
      sessions,
      { origin: url.origin, issuer, resource, scopes },
      next,
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Set-Cookie": setCookie,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (url.pathname === "/.auth/callback") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
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
    try {
      await session?.end();
    } catch {
      console.error("oauth.app_logout_failed", { origin: url.origin });
      return new Response(
        "Sign-out could not complete. Your session is still present; go back and try again.",
        { status: 503 },
      );
    }
    const headers = new Headers({
      Location: sameOriginPath(url.searchParams.get("next") || "/", url.origin),
      "Set-Cookie": clearCookie,
      "Cache-Control": "no-store",
    });
    return new Response(null, { status: 303, headers });
  }
  if (url.pathname === "/api") {
    let token = request.headers.get("authorization");
    let cookieAuth = false;
    if (!token && request.method !== "OPTIONS") {
      if (session && request.headers.get("origin") !== url.origin)
        return new Response("A browser API request must have the same origin", { status: 403 });
      const bearer = await session?.bearer();
      if (bearer) {
        token = `Bearer ${bearer}`;
        cookieAuth = true;
      }
    }
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    // The same-origin gate above already ran. Provider CORS reconstruction loses 101.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") headers.delete("origin");
    if (token) headers.set("authorization", token);
    const response = await config.api(new Request(resource, new Request(request, { headers })));
    if (cookieAuth && response.status === 401) {
      await session!.discard();
      const denied = new Response(response.body, response);
      denied.headers.append("Set-Cookie", clearCookie);
      return denied;
    }
    return response;
  }
  if (url.pathname.startsWith("/.auth/")) return new Response("Not found", { status: 404 });
  return null;
}
