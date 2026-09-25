// project-host-sign-in.ts — who a project host's request arrives as, and what the edge makes of an
// app's "sign in to iterate" answer. Pure (no I/O); worker.ts calls both functions on every project
// host request, and project-host-sign-in.test.ts is their table.
//
// WHO ARRIVES — projectHostCallerOf; only a "member" is stamped `x-itx-principal` (and its grant):
//   1. No verified credential: anonymous.
//   2. A verified credential whose reach does not include the project: a non-member. It goes on
//      ANONYMOUS, never refused: what an anonymous visitor may see is the app's call.
//   3. The session COOKIE counts on a write (any method but GET, HEAD, OPTIONS) or a WebSocket
//      upgrade only from the host's own origin (iterate/lib `isSameOriginBrowserRequest`: an absent
//      Origin passes). Otherwise the request goes on anonymous. A bearer is never sent by a browser
//      on its own, so it always counts. A principal an app is handed is therefore safe to act on.
//   4. Everything else: a member.
//
// THE SIGN-IN CHALLENGE — projectHostSignInAnswerOf: an app asks for a signed-in caller by answering
// 401 with `WWW-Authenticate: Bearer realm="iterate"` (iterate/sdk `auth.require`). Only that
// challenge is the platform's; a 401 with another scheme or realm is the app's own and passes
// untouched, as does every other status (a WebSocket's 101 included).
//   5. A member: the 401 passes (a sign-in would bring the same principal back: a loop).
//   6. A top-level document navigation (GET or HEAD with `Sec-Fetch-Mode: navigate` and
//      `Sec-Fetch-Dest: document`; with neither header, an `Accept` naming text/html):
//        anonymous  → 302 to `<login>?next=<path>`
//        non-member → 302 to `<login>?project=<slug>&next=<path>`, iterate/app-server's
//                     "Sign in again" page: tick the project at consent, or switch account
//      `<path>` is the path and query the browser addressed (a paths-routed base path included),
//      always a path on the host's own origin (iterate/lib `sameOriginPath`).
//   7. Anything else (a fetch, a write, an upgrade): anonymous → the 401 passes; non-member → 403 (a
//      401 would send an OAuth client to authorize again, to be handed the same token).
//
// PATHS INGRESS IS MEMBERS-ONLY — pathsIngressRefusalOf: under paths routing every app runs on the
// platform's own origin, where its script can act as whoever is signed in there, so the edge admits
// only the project's members to any project path, before the app is asked:
//   8. A member passes.
//   9. Anonymous: a top-level document navigation (rule 6's test) → 302 to `<login>?next=<path>`;
//      anything else → 401 with the platform's challenge, `Bearer realm="iterate"`.
//  10. A non-member → 403.

import { isSameOriginBrowserRequest, sameOriginPath } from "iterate/lib";

/** Who a project host's request arrives as (rules 1–4). */
export type ProjectHostCaller = "member" | "non-member" | "anonymous";

type RequestShape = Pick<Request, "method" | "url" | "headers">;

/** Rules 1–4: `authorization` is the credential that verified (null: none did), how it came, and
 *  whether its reach includes the project. */
export function projectHostCallerOf(input: {
  authorization: { via: "bearer" | "cookie"; reachesProject: boolean } | null;
  request: RequestShape;
}): ProjectHostCaller {
  const { authorization, request } = input;
  if (!authorization) return "anonymous";
  if (!authorization.reachesProject) return "non-member";
  const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const isWrite = isWebSocketUpgrade || !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (authorization.via === "cookie" && isWrite && !isSameOriginBrowserRequest(request))
    return "anonymous";
  return "member";
}

/** Rules 5–7: the edge's answer in place of the app's, or null when the app's answer stands.
 *  `loginUrl` is the absolute `/.auth/login` of the browser adapter serving this host. */
export function projectHostSignInAnswerOf(input: {
  answer: Pick<Response, "status" | "headers">;
  request: RequestShape;
  caller: ProjectHostCaller;
  projectSlug: string;
  loginUrl: string;
}): Response | null {
  const { answer, request, caller } = input;
  if (answer.status !== 401 || caller === "member") return null;
  if (!isIterateSignInChallenge(answer.headers.get("www-authenticate"))) return null;
  if (isDocumentNavigation(request))
    return signInRedirect(
      request,
      input.loginUrl,
      caller === "non-member" ? { project: input.projectSlug } : {},
    );
  if (caller === "non-member")
    return new Response("This session cannot access this project\n", { status: 403 });
  return null;
}

/** Rules 8–10: the edge's answer to a request on a project path under paths routing, or null when
 *  the caller is a member and the request goes on to the app. `loginUrl` is the platform's absolute
 *  `/.auth/login`. */
export function pathsIngressRefusalOf(input: {
  request: RequestShape;
  caller: ProjectHostCaller;
  projectSlug: string;
  loginUrl: string;
}): Response | null {
  const { request, caller } = input;
  if (caller === "member") return null;
  if (caller === "non-member")
    return new Response(`You are not a member of the project ${input.projectSlug}.\n`, {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  if (isDocumentNavigation(request)) return signInRedirect(request, input.loginUrl, {});
  return new Response("Sign in to iterate\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="iterate"', "Cache-Control": "no-store" },
  });
}

/** The 302 to `loginUrl` that comes back to the path and query the browser addressed (a
 *  paths-routed base path included), always a path on the request's own origin. */
function signInRedirect(
  request: RequestShape,
  loginUrl: string,
  query: Record<string, string>,
): Response {
  const url = new URL(request.url);
  const next = sameOriginPath(url.pathname + url.search, url.origin);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${loginUrl}?${new URLSearchParams({ ...query, next })}`,
      "Cache-Control": "no-store",
    },
  });
}

/** An auth-scheme or auth-param name (RFC 9110 `token`). */
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
/** One auth-param, `name=token` or `name="quoted string"`, up to the next comma. */
const AUTH_PARAM = new RegExp(
  `^(${TOKEN})[ \\t]*=[ \\t]*(${TOKEN}|"(?:[^"\\\\]|\\\\.)*")[ \\t]*(?:,|$)`,
);
/** A challenge's scheme, with the token68 that may follow it (`Negotiate abc==`). */
const AUTH_SCHEME = new RegExp(`^(${TOKEN})(?:[ \\t]+[A-Za-z0-9._~+/-]+=*[ \\t]*(?=,|$))?`);

/** Does a `WWW-Authenticate` value (every challenge, as `Headers.get` joins them) hold the
 *  platform's sign-in challenge — scheme `Bearer` (any case) with `realm="iterate"`? RFC 9110
 *  §11.6.1's challenge list, parsed; a value that does not parse holds no challenge of ours. */
export function isIterateSignInChallenge(header: string | null): boolean {
  let rest = header || "";
  let scheme: string | null = null;
  for (;;) {
    rest = rest.replace(/^[\s,]+/, "");
    if (!rest) return false;
    const param = scheme ? AUTH_PARAM.exec(rest) : null;
    if (param) {
      const value = param[2]!.startsWith('"')
        ? param[2]!.slice(1, -1).replace(/\\(.)/g, "$1")
        : param[2];
      if (scheme === "bearer" && param[1]!.toLowerCase() === "realm" && value === "iterate")
        return true;
      rest = rest.slice(param[0].length);
      continue;
    }
    const challenge = AUTH_SCHEME.exec(rest);
    if (!challenge) return false;
    scheme = challenge[1]!.toLowerCase();
    rest = rest.slice(challenge[0].length);
  }
}

/** A browser loading a page into its window: GET or HEAD, `Sec-Fetch-Mode: navigate` with
 *  `Sec-Fetch-Dest: document` (a frame, an image or a fetch is not one); a client that sends
 *  neither header is a navigation when it asks for HTML. */
function isDocumentNavigation(request: RequestShape): boolean {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return false;
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  if (!mode && !destination) return (request.headers.get("accept") ?? "").includes("text/html");
  return mode === "navigate" && destination === "document";
}
