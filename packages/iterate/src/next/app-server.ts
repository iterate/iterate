// eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded read for the Sign-in-again page, no live capabilities.
import { newHttpBatchRpcSession } from "capnweb";
import type { BrowserHost, BrowserSession } from "./app-session.ts";
import type { IterateApi } from "./api.ts";
import { cookieValueOf } from "./principal.ts";
import { isSameOriginBrowserRequest, sameOriginPath } from "./lib.ts";
import { OAuthScopes } from "./oauth-scopes.ts";

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

/** What the app's own sign-in currently is, for the Sign-in-again page to show: who it is signed in
 *  as, and the projects it reaches — its grant, the thing that turned out not to include the project
 *  the page named. One bounded HTTP-batch read of the platform (the logout path's shape), best
 *  effort: a slow or failed read simply leaves those lines off, the page still works. */
async function grantSummary(resource: string, bearer: string) {
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded read, no live capabilities.
  using api = newHttpBatchRpcSession<IterateApi>(
    new Request(resource, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(5_000),
    }),
  );
  using session = api.authenticate({ type: "from-server-cookie" });
  const info = session.info();
  const projects = session.projects.list();
  const [{ principal }, list] = await Promise.all([info, projects]);
  return { email: principal.email, projects: list.map((project) => project.slug) };
}

/** What each scope is, to the person, in one or two words — the Sign-in-again page's permissions
 *  line. The consent page (public/authorize.js) spells the same three at sentence length. */
const scopeLabels: Record<string, string> = {
  iterate: "your projects",
  account: "your account",
  "organizations:write": "your organizations",
};

/** The sign-in this browser holds does not cover what the page needs: a project the page named
 *  (`?project=`, the page's own word — its `/projects/<ref>` was absent from the session's list; the
 *  page is not verified, it only offers a sign-out the person must click) or a permission the app
 *  asks for. One page for both, on the app's origin because ending its session is a same-origin
 *  POST, dressed by the issuer's stylesheet: it is the next page of the same sign-in. It shows who
 *  the app is signed in as and the projects that sign-in reaches (its grant), then one button that
 *  ends this app's session and comes straight back to `/.auth/login`, which starts a fresh one —
 *  the issuer still knows the person, so they land on consent: the project to tick, or Switch
 *  account — and returns to the page that sent them. */
async function signInAgainPage(input: {
  url: URL;
  issuer: string;
  resource: string;
  bearer: string;
  scopes: string[];
  project: string | null;
}) {
  const { url, issuer, resource, bearer, scopes, project } = input;
  const text = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const lacks = project
    ? `does not include a project called <code>${text(project)}</code>`
    : "does not include a permission this app asks for";
  const grant = await grantSummary(resource, bearer).catch(() => null);
  const reaches = grant
    ? grant.projects.length
      ? `It reaches ${grant.projects
          .slice(0, 12)
          .map((slug) => `<code>${text(slug)}</code>`)
          .join(
            ", ",
          )}${grant.projects.length > 12 ? ` and ${grant.projects.length - 12} more` : ""}.`
      : "It reaches no projects yet."
    : "";
  const permissions = `Permissions: ${scopes.map((scope) => scopeLabels[scope] || scope).join(", ")}.`;
  const signedIn = [
    grant?.email ? `Signed in as <strong>${text(grant.email)}</strong>.` : "",
    reaches,
    permissions,
  ]
    .filter(Boolean)
    .join(" ");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in again</title><link rel="stylesheet" href="${issuer}/issuer.css"><link rel="icon" href="${issuer}/iterate-logo.svg" type="image/svg+xml"></head><body><main class="issuer-card"><img class="issuer-mark" src="${issuer}/iterate-logo.svg" alt="" width="56" height="56"><h1>Sign in again</h1><p>Your sign-in to <strong>${text(url.host)}</strong> ${lacks}.</p><p class="muted">${signedIn}</p><p class="muted">Signing in again brings you back here. At consent, tick the project — or switch account.</p><form method="post" action="/.auth/logout?next=${encodeURIComponent(url.pathname + url.search)}"><button class="primary" type="submit">Sign in again</button></form></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

type AppAuth = {
  sessions: DurableObjectNamespace<BrowserSession>;
  issuer: string;
  resource: string;
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
        : [],
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
        if (!probe.ok) throw new Error(`iterate API check failed (${probe.status})`);
        const heldScopes = await session!.scopes();
        const project = url.searchParams.get("project");
        if (!project && scopes.every((scope) => heldScopes.includes(scope)))
          return new Response(null, {
            status: 303,
            headers: { Location: next, "Cache-Control": "no-store" },
          });
        // Only a deliberate POST can replace a valid grant. GET never signs out.
        return signInAgainPage({ url, issuer, resource, bearer, scopes: heldScopes, project });
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
    const result = await session?.complete(url.search);
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
      // THE COOKIE'S AUTHORITY IS SAME-ORIGIN ONLY (CSRF): a page on another origin that happens to
      // carry this app's cookie gets nothing from it — its request goes on BARE, and a WebSocket then
      // authenticates in-band with its own token, `authenticate({ type: "bearer", token })` (os-next
      // api.ts), or holds no session at all.
      const bearer =
        session && request.headers.get("origin") === url.origin ? await session.bearer() : null;
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
