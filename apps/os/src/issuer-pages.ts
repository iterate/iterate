// The issuer's browser pages are TanStack Start routes (src/routes): the landing page, sign-in and
// consent, with their form posts and server functions. This handler admits exactly those requests
// into Start — same-origin POSTs, server-function payloads restricted to plain data, a CSP nonce per
// response — and serves the public files beside them. The platform's API and OAuth endpoints are
// owned by the Worker and never reach it.

import { isSameOriginBrowserRequest } from "iterate/next/lib";
import { z } from "zod";
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

/** Seroval's JSON form of plain data — what Start's client sends as server-function input: numbers,
 *  strings, constants (null, undefined, booleans), arrays and plain objects. Start decodes whatever
 *  Seroval can express (promises, frozen objects, plugin values) before any input validator runs,
 *  so nothing else is admitted. */
const PlainDataNode: z.ZodType = z.lazy(() =>
  z.union([
    z.strictObject({ t: z.literal(0), s: z.number() }),
    z.strictObject({ t: z.literal(1), s: z.string() }),
    z.strictObject({ t: z.literal(2), s: z.number().int().min(0).max(7) }),
    z.strictObject({
      t: z.literal(9),
      i: z.number().int(),
      a: z.array(PlainDataNode),
      o: z.literal(0),
    }),
    z.strictObject({
      t: z.literal(10),
      i: z.number().int(),
      p: z
        .strictObject({
          k: z.array(z.string().refine((key) => key !== "__proto__")),
          v: z.array(PlainDataNode),
        })
        .refine(({ k, v }) => k.length === v.length && new Set(k).size === k.length),
      o: z.literal(0),
    }),
  ]),
);
/** `{ data }` — the one key an issuer server function reads (no client-sent context). */
const ServerFunctionPayload = z.strictObject({
  t: z.strictObject({
    t: z.literal(10),
    i: z.literal(0),
    p: z.strictObject({
      k: z.union([z.tuple([]), z.tuple([z.literal("data")])]),
      v: z.array(PlainDataNode).max(1),
    }),
    o: z.literal(0),
  }),
  f: z.number().int(),
  m: z.tuple([]),
});

/** Why a server-function request may not reach Start, or null when it may. */
async function serverFunctionRefusal(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  // Start reports unknown server-function IDs as 500s; only the issuer's own are served here.
  const { issuerServerFunctions } = await import("./issuer.functions.ts");
  if (!issuerServerFunctions.some((serverFunction) => serverFunction.url === url.pathname))
    return new Response("Not found", { status: 404 });
  let payload: string | null;
  if (request.method === "GET") payload = url.searchParams.get("payload");
  else if (request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return new Response("Server functions take JSON", { status: 415 });
    if (Number(request.headers.get("content-length")) > 1_000_000)
      return new Response("Payload too large", { status: 413 });
    payload = await request.clone().text();
  } else return new Response("Method not allowed", { status: 405 });
  if (!payload) return null;
  if (payload.length > 1_000_000) return new Response("Payload too large", { status: 413 });
  try {
    if (ServerFunctionPayload.safeParse(JSON.parse(payload)).success) return null;
  } catch {
    // not JSON, or nested past what the parser handles: malformed either way
  }
  return new Response("Invalid server-function payload", { status: 400 });
}

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
    if (pathname.startsWith("/_serverFn/"))
      return (await serverFunctionRefusal(request)) ?? startResponse(request, env, ctx);
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
