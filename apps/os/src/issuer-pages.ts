// The issuer's browser pages are TanStack Start routes (src/routes): the landing page, sign-in and
// consent, with their form posts and server functions. This handler admits exactly those requests
// into Start — same-origin POSTs, its pages with their own methods, and its server functions, which
// Start's global middleware (src/start.ts) holds to known IDs and plain data — gives each response
// a CSP nonce, and serves the public files beside them. The platform's API and OAuth endpoints are
// owned by the Worker and never reach it.

import { isSameOriginBrowserRequest } from "iterate/next/lib";
import type { Env, Handler } from "./env.ts";
import { withIssuerRequest } from "./issuer-request-context.server.ts";

/** The Start routes, with the methods each answers (POST is the page's own form). */
const issuerPageMethods = new Map([
  ["/", ["GET", "HEAD"]],
  ["/login", ["GET", "HEAD", "POST"]],
  ["/oauth2/auth", ["GET", "HEAD", "POST"]],
]);

const publicFiles = new Set([
  "/iterate-logo.svg",
  "/google-logo.svg",
  "/cloudflare-logo.svg",
  // the stylesheet apps' own sign-in pages link from their issuer (iterate/next/app-server)
  "/issuer.css",
  // the prompt an agent follows to deploy and connect a platform of the person's own
  "/setup-prompt.md",
]);

/** Start answers a page request that does not accept HTML with a 500; it is a 406. */
function acceptsHtml(request: Request) {
  const accept = request.headers.get("accept") || "*/*";
  return accept
    .split(",")
    .some((part) => part.trim().startsWith("*/*") || part.trim().startsWith("text/html"));
}

/** Start's answer, with the headers every issuer response carries: never cached, never framed,
 *  scripts only from this origin or with this response's nonce. Base UI hides its native inputs
 *  with style attributes, so those (and only those) may be inline. */
async function startResponse(request: Request, env: Env, ctx: ExecutionContext) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  // API and OAuth traffic bypasses the React server runtime entirely.
  const { default: entry } = await import("@tanstack/react-start/server-entry");
  const rendered = await withIssuerRequest(env, ctx, nonce, () => entry.fetch(request));
  const response = new Response(rendered.body, rendered);
  response.headers.set("cache-control", "no-store");
  response.headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'self' 'nonce-${nonce}'${import.meta.env.DEV ? " 'unsafe-eval'" : ""}; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; base-uri 'none'; frame-ancestors 'none'`,
  );
  response.headers.set("x-frame-options", "DENY");
  return response;
}

/** The issuer's pages, their server functions and public files. */
export const issuerHandler: Handler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/_serverFn/")) return startResponse(request, env, ctx);
    const pageMethods = issuerPageMethods.get(pathname);
    if (pageMethods) {
      if (!pageMethods.includes(request.method))
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: pageMethods.join(", ") },
        });
      if (request.method !== "POST" && !acceptsHtml(request))
        return new Response("Not acceptable: this page is HTML", { status: 406 });
      return startResponse(request, env, ctx);
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Not found", { status: 404 });
    // Vite emits hashed Start assets under /assets; the Worker still owns the platform origin.
    if (
      publicFiles.has(pathname) ||
      pathname.startsWith("/assets/") ||
      (import.meta.env.DEV &&
        (pathname.startsWith("/@") ||
          pathname.startsWith("/node_modules/") ||
          pathname.startsWith("/src/")))
    )
      return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
