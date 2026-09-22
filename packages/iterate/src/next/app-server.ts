// app-server.ts — THE BROWSER-AUTH GATE every app worker runs first: the OAuth client (one CIMD
// client id per app origin, PKCE, the `__Host-` cookie), the `/api` proxy, and the few pages the gate
// serves itself. A browser session is an ordinary OAuth client of ONE issuer — by default the
// deployment's own (`config.issuer`), or any os-next issuer a person CONNECTS the app to on purpose (a
// self-hosted platform). Connecting is deliberate: a same-origin POST from `/.auth/connect`, a page
// that names the issuer and asks — never a link, because a link would be a forced login: it could
// bind a browser to an issuer of the linker's choosing, and the app would then show that issuer's
// world as the person's. Once a session exists, its record is the ONLY source of where the credential
// goes (`BrowserSession.host()`): the login probe, the `/api` proxy and logout all read it there.
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

/** What an issuer a person names must be: an https ORIGIN (a path or query is dropped, not refused),
 *  not an IP literal, not loopback, and not under one of this deployment's own zones (`denyZones` —
 *  a project host on our wildcard is userspace and could serve a look-alike issuer) — unless it IS
 *  the deployment's default issuer, which is always allowed as it is. Pure: the discovery check that
 *  the origin really answers as that issuer is `issuerAnswersAt`. */
export function issuerOriginOf(
  candidate: string,
  options: { defaultIssuer: string; denyZones?: readonly string[] },
): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return { error: "Enter the issuer's address, like https://iterate.example.workers.dev." };
  }
  const origin = url.origin;
  if (origin === options.defaultIssuer) return { origin };
  if (url.protocol !== "https:") return { error: "The issuer must be served over https." };
  const host = url.hostname;
  if (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.startsWith("[") ||
    host === "localhost" ||
    host.endsWith(".localhost")
  )
    return { error: "The issuer must have a public hostname." };
  for (const zone of options.denyZones || []) {
    const denied = zone.toLowerCase().replace(/^\.+/, "");
    if (denied && (host === denied || host.endsWith(`.${denied}`)))
      return { error: `${host} is not an issuer this app can be connected to.` };
  }
  return { origin };
}

/** The issuer must say it is the issuer: its discovery document's `issuer` equals the origin
 *  exactly. NOTHING else is read from the document — the endpoints stay hand-built from the origin
 *  (app-session.ts: `/oauth2/token`, and `/api` as the resource), so a document can steer nothing.
 *  Null when it answers as expected, else the reason. */
async function issuerAnswersAt(origin: string): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return `${new URL(origin).host} does not answer as an iterate platform.`;
    const document: unknown = await response.json();
    const issuer =
      typeof document === "object" && document ? (document as { issuer?: unknown }).issuer : null;
    if (issuer !== origin)
      return `${new URL(origin).host} does not answer as an iterate platform (its issuer is ${typeof issuer === "string" ? issuer : "missing"}).`;
    return null;
  } catch {
    return `${new URL(origin).host} could not be reached.`;
  }
}

/** `next` as a same-origin path with any `issuer` query parameter removed — an issuer rides in
 *  through `/.auth/connect` and nowhere else, so a `next` can never carry one back into a login
 *  (the Sign-in-again form returns to the very login URL that showed it). Untouched when there is
 *  none to remove, so what a page sent stays byte for byte. */
function nextPathOf(next: string | null, origin: string): string {
  const path = sameOriginPath(next || "/", origin);
  const url = new URL(path, origin);
  if (!url.searchParams.has("issuer")) return path;
  url.searchParams.delete("issuer");
  return url.pathname + url.search;
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

const text = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The gate's own pages, dressed without asking anyone: the issuer's stylesheet is loaded only when
 *  the issuer is the deployment's own (a stylesheet is a document's dress, and an issuer a person
 *  typed does not get to dress a page on this origin). */
const inlinePageCss = `body{margin:0;min-height:100svh;display:grid;place-items:center;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#18181b;background:#fafafa}main{width:min(28rem,calc(100% - 2rem));padding:2rem;background:#fff;border:1px solid #e4e4e7;border-radius:12px}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 .75rem}.muted{color:#71717a}code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}button,.button{display:inline-block;padding:.55rem 1rem;border:0;border-radius:8px;background:#18181b;color:#fff;font:inherit;cursor:pointer;text-decoration:none}a.quiet{color:#71717a;margin-left:1rem}`;

/** A page of the gate's own: `head` is what the head carries beyond the title, `body` the card. */
function gatePage(input: {
  title: string;
  head: string;
  body: string;
  csp: string;
  status?: number;
}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(input.title)}</title>${input.head}</head><body><main class="issuer-card">${input.body}</main></body></html>`,
    {
      status: input.status ?? 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": input.csp,
        "X-Frame-Options": "DENY",
      },
    },
  );
}

/** The head and the CSP of a gate page: the deployment's own issuer dresses it (its stylesheet, its
 *  logo); any other issuer gets the inline dress and nothing of its own on this origin. */
function dressOf(
  issuer: string,
  defaultIssuer: string,
): { head: string; csp: string; mark: string } {
  if (issuer === defaultIssuer)
    return {
      head: `<link rel="stylesheet" href="${issuer}/issuer.css"><link rel="icon" href="${issuer}/iterate-logo.svg" type="image/svg+xml">`,
      csp: `default-src 'none'; style-src ${issuer}; img-src ${issuer}; form-action 'self'; frame-ancestors 'none'`,
      mark: `<img class="issuer-mark" src="${issuer}/iterate-logo.svg" alt="" width="56" height="56">`,
    };
  return {
    head: `<style>${inlinePageCss}</style>`,
    csp: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    mark: "",
  };
}

/** The sign-in this browser holds does not cover what the page needs: a project the page named
 *  (`?project=`, the page's own word — its `/projects/<ref>` was absent from the session's list; the
 *  page is not verified, it only offers a sign-out the person must click) or a permission the app
 *  asks for. One page for both, on the app's origin because ending its session is a same-origin
 *  POST. It shows who the app is signed in as, through which issuer, and the projects that sign-in
 *  reaches (its grant), then one button that ends this app's session and comes straight back to
 *  `/.auth/login`, which starts a fresh one — the issuer still knows the person, so they land on
 *  consent: the project to tick, or Switch account — and returns to the page that sent them. */
async function signInAgainPage(input: {
  url: URL;
  issuer: string;
  resource: string;
  defaultIssuer: string;
  bearer: string;
  scopes: string[];
  project: string | null;
}) {
  const { url, issuer, resource, defaultIssuer, bearer, scopes, project } = input;
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
    grant?.email ? `Signed in as <strong>${text(grant.email)}</strong>` : "Signed in",
    ` through <strong>${text(new URL(issuer).host)}</strong>.`,
    reaches,
    permissions,
  ]
    .filter(Boolean)
    .join(" ")
    .replace("</strong>  through", "</strong> through");
  const dress = dressOf(issuer, defaultIssuer);
  const back = nextPathOf(url.pathname + url.search, url.origin);
  return gatePage({
    title: "Sign in again",
    head: dress.head,
    csp: dress.csp,
    body: `${dress.mark}<h1>Sign in again</h1><p>Your sign-in to <strong>${text(url.host)}</strong> ${lacks}.</p><p class="muted">${signedIn}</p><p class="muted">Signing in again brings you back here. At consent, tick the project — or switch account.</p><form method="post" action="/.auth/logout?next=${encodeURIComponent(back)}"><button class="primary" type="submit">Sign in again</button></form>`,
  });
}

/** `/.auth/connect` — the one page that may bind this browser to an issuer other than the
 *  deployment's own: it names the issuer's host in plain text, says what it will end, and asks. The
 *  Continue button is a same-origin POST; the page loads nothing from the issuer it names. */
function connectPage(input: {
  url: URL;
  origin: string;
  next: string;
  scope: string | null;
  held: { issuer: string } | null;
  defaultIssuer: string;
}): Response {
  const { url, origin, next, scope, held, defaultIssuer } = input;
  const host = new URL(origin).host;
  const ends =
    held && held.issuer !== origin
      ? `<p class="muted">This ends your current sign-in through <strong>${text(new URL(held.issuer).host)}</strong>.</p>`
      : "";
  const dress = dressOf(defaultIssuer, defaultIssuer);
  return gatePage({
    title: `Connect to ${host}`,
    head: dress.head,
    csp: dress.csp,
    body: `${dress.mark}<h1>Connect ${text(url.host)} to <code>${text(host)}</code>?</h1><p>This app will sign you in through <strong>${text(host)}</strong> and show what that platform holds. Continue only if that is your own iterate platform.</p>${ends}<form method="post" action="/.auth/connect"><input type="hidden" name="issuer" value="${text(origin)}"><input type="hidden" name="next" value="${text(next)}">${scope ? `<input type="hidden" name="scope" value="${text(scope)}">` : ""}<button class="primary" type="submit">Continue</button><a class="quiet" href="/">Cancel</a></form>`,
  });
}

/** A refusal of the gate's own, as a page the person can read. */
function refusalPage(defaultIssuer: string, message: string, status = 400): Response {
  const dress = dressOf(defaultIssuer, defaultIssuer);
  return gatePage({
    title: "Cannot connect",
    head: dress.head,
    csp: dress.csp,
    status,
    body: `${dress.mark}<h1>Cannot connect</h1><p>${text(message)}</p><p><a class="button" href="/">Back</a></p>`,
  });
}

type AppAuth = {
  /** Public app branding; relative logo paths resolve against this app's origin. */
  client?: { name: string; logoUri: string };
  sessions: DurableObjectNamespace<BrowserSession>;
  /** The deployment's own issuer — where a browser with no session signs in. */
  issuer: string;
  /** Its `/api`. */
  resource: string;
  /** Platform dispatches in process to avoid /api recursion; other apps pass fetch. */
  api: (request: Request) => Promise<Response> | Response;
  /** The issuer proves identity before establishing its own ordinary app session. */
  loginPage?: string;
  /** Zones no connectable issuer may live under (`issuerOriginOf`): this deployment's own, whose
   *  project hosts are userspace. The default issuer is exempt. */
  denyZones?: readonly string[];
};

/** The same OAuth client and /api proxy on a platform host or a separate app worker. */
export async function appAuth(request: Request, config: AppAuth): Promise<Response | null> {
  const url = new URL(request.url);
  const { issuer, resource, sessions } = config;
  const client = config.client && {
    name: config.client.name,
    logoUri: new URL(config.client.logoUri, url.origin).href,
  };
  const session = appSession(sessions, request);
  const clearCookie = `${sessionCookieName(url)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  /** Where THIS browser's credential goes: its session's record, else the deployment's own. A record
   *  bound to a CONNECTED issuer whose resource is not that issuer's `/api` is not one this code
   *  wrote — it is dropped (the deployment's own issuer may name its resource as it likes). */
  const held = async (): Promise<{ issuer: string; resource: string } | null> => {
    const host = await session?.host();
    if (!host) return null;
    if (host.issuer !== issuer && host.resource !== `${host.issuer}/api`) {
      await session!.discard();
      return null;
    }
    return host;
  };
  if (url.pathname === "/.auth/client.json")
    return Response.json(
      {
        client_id: `${url.origin}/.auth/client.json`,
        client_name: client?.name || url.host,
        client_uri: url.origin,
        logo_uri: client?.logoUri,
        redirect_uris: [`${url.origin}/.auth/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );

  if (url.pathname === "/.auth/session.json") {
    // which issuer this browser is connected to — the app's shell says so when it is not the
    // deployment's own; no credential, no identity, nothing a page on another origin could use
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const host = await held();
    return Response.json(
      { issuer: host?.issuer ?? null, defaultIssuer: issuer },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (url.pathname === "/.auth/connect") {
    if (config.loginPage) return new Response("Not found", { status: 404 });
    if (request.method === "GET") {
      const named = issuerOriginOf(url.searchParams.get("issuer") ?? "", {
        defaultIssuer: issuer,
        denyZones: config.denyZones,
      });
      if ("error" in named) return refusalPage(issuer, named.error);
      const next = nextPathOf(url.searchParams.get("next"), url.origin);
      const scope = url.searchParams.get("scope");
      const host = await held();
      // the deployment's own issuer needs no asking when this browser is not bound elsewhere
      if (named.origin === issuer && (!host || host.issuer === issuer))
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/.auth/login?${new URLSearchParams({ next, scope: scope || "" })}`,
            "Cache-Control": "no-store",
          },
        });
      return connectPage({
        url,
        origin: named.origin,
        next,
        scope,
        held: host,
        defaultIssuer: issuer,
      });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!isSameOriginBrowserRequest(request))
      return new Response("Cross-site request refused", { status: 403 });
    const form = await request.formData();
    const named = issuerOriginOf(String(form.get("issuer") ?? ""), {
      defaultIssuer: issuer,
      denyZones: config.denyZones,
    });
    if ("error" in named) return refusalPage(issuer, named.error);
    const next = nextPathOf(String(form.get("next") ?? "/"), url.origin);
    const parsed = OAuthScopes.safeParse(
      String(form.get("scope") ?? "")
        .split(" ")
        .filter(Boolean),
    );
    if (!parsed.success) return refusalPage(issuer, "Unsupported permission.");
    if (named.origin !== issuer) {
      const refused = await issuerAnswersAt(named.origin);
      if (refused) return refusalPage(issuer, refused);
    }
    const host = await held();
    if (host?.issuer === named.origin)
      return new Response(null, {
        status: 303,
        headers: {
          Location: `/.auth/login?${new URLSearchParams({ next, scope: parsed.data.join(" ") })}`,
          "Cache-Control": "no-store",
        },
      });
    if (host) {
      // a deliberate switch: end the sign-in at the issuer it was with (best effort — that issuer
      // may be gone), then forget it here either way
      try {
        await session!.end();
      } catch {
        await session!.discard();
      }
    }
    const { location, setCookie } = await startAppSession(
      sessions,
      {
        origin: url.origin,
        client,
        issuer: named.origin,
        resource: `${named.origin}/api`,
        scopes: parsed.data,
      },
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

  if (url.pathname === "/.auth/login") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const next = nextPathOf(url.searchParams.get("next"), url.origin);
    const scope = url.searchParams.get("scope");
    const parsed = OAuthScopes.safeParse(scope ? scope.split(" ").filter(Boolean) : []);
    if (!parsed.success) return new Response("Unsupported permission", { status: 400 });
    const scopes = parsed.data;
    // A link may NAME an issuer; only the connect page's POST may bind one. So a login link that
    // names one lands on that page (which also says no to a bad one) — a click is always required.
    const requested = url.searchParams.get("issuer");
    if (requested && !config.loginPage) {
      const named = issuerOriginOf(requested, {
        defaultIssuer: issuer,
        denyZones: config.denyZones,
      });
      if ("error" in named || named.origin !== issuer)
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/.auth/connect?${new URLSearchParams({ issuer: requested, next, scope: scope || "" })}`,
            "Cache-Control": "no-store",
          },
        });
    }
    const host = await held();
    const target = host || { issuer, resource };
    const bearer = await session?.bearer();
    if (bearer) {
      const probe = await config.api(
        new Request(target.resource, {
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
        return signInAgainPage({
          url,
          issuer: target.issuer,
          resource: target.resource,
          defaultIssuer: issuer,
          bearer,
          scopes: heldScopes,
          project,
        });
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
    // The fresh session goes where this browser was CONNECTED (an expired grant at a self-host
    // signs in again at that self-host, not at the deployment's own issuer); a browser with no
    // record signs in at the default.
    const { location, setCookie } = await startAppSession(
      sessions,
      { origin: url.origin, issuer: target.issuer, resource: target.resource, scopes, client },
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
    // Where the ended session was bound: a sign-out from a CONNECTED issuer returns through the
    // connect page for that issuer (one click, the host named), so "Sign in again" at a self-host
    // stays at the self-host instead of silently binding the browser back to the default.
    const ended = await held();
    try {
      await session?.end();
    } catch {
      console.error("oauth.app_logout_failed", { origin: url.origin });
      return new Response(
        "Sign-out could not complete. Your session is still present; go back and try again.",
        { status: 503 },
      );
    }
    const next = nextPathOf(url.searchParams.get("next"), url.origin);
    // The scopes the next sign-in must hold ride along: the Sign-in-again form's `next` IS the login
    // URL that asked for them (`/.auth/login?…&scope=…`), and the connect page starts the grant from
    // its own `scope` — without this the reconnected grant would hold `iterate` alone and the login
    // would send the person straight back to Sign in again.
    const nextUrl = new URL(next, url.origin);
    const scope =
      nextUrl.pathname === "/.auth/login" ? nextUrl.searchParams.get("scope") || "" : "";
    const headers = new Headers({
      Location:
        ended && ended.issuer !== issuer && !config.loginPage
          ? `/.auth/connect?${new URLSearchParams({ issuer: ended.issuer, next, scope })}`
          : next,
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
    // where the credential goes is the session's record, never anything on the request
    const target = (await held()) ?? { issuer, resource };
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    // The same-origin gate above already ran. Provider CORS reconstruction loses 101.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") headers.delete("origin");
    if (token) headers.set("authorization", token);
    const response = await config.api(
      new Request(target.resource, new Request(request, { headers })),
    );
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
