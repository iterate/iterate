import {
  AuthorizationError,
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { address, Fault } from "./model.ts";
import { sha256 } from "./encoding.ts";

export interface AuthEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_ORIGIN: string;
}
const redirect = (location: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", ...(cookie && { "set-cookie": cookie }) },
  });
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
function form(title: string, fields: string, button: string) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><main><h1>${title}</h1>
    <p>Architectural demo: no email verification. Projects are shared sandbox data, not private accounts.</p>
    <form method="post">${fields}<p><button>${button}</button></p></form></main></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

type Core<Env> = { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };
/** Browser identity outside the core; provider-issued OAuth grants only at the MCP edge. */
export function withLogin<Env extends AuthEnv>(core: Core<Env>) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN) return new Response("Wrong origin", { status: 421 });
      const provider = new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: {
          fetch(request, env, ctx) {
            const url = new URL(request.url);
            const props = z.object({ project: z.string() }).parse(ctx.props);
            if (url.pathname !== "/mcp" || url.searchParams.get("project") !== props.project)
              return new Response("Project not granted", { status: 403 });
            return core.fetch(request, env, ctx);
          },
        },
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        scopesSupported: ["project"],
        allowPlainPKCE: false,
        clientIdMetadataDocumentEnabled: false,
        resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, scopes_supported: ["project"] },
        defaultHandler: {
          async fetch(request, env, ctx) {
            const url = new URL(request.url);
            if (["/version", "/secrets", "/style.css"].includes(url.pathname))
              return core.fetch(request, env, ctx);
            const origin = request.headers.get("origin");
            if (origin && origin !== url.origin)
              return new Response("Cross-origin request denied", { status: 403 });
            const cookieName = url.protocol === "https:" ? "__Host-core-session" : "core-session";
            const token = request.headers
              .get("cookie")
              ?.split(/;\s*/)
              .find((part) => part.startsWith(`${cookieName}=`))
              ?.slice(cookieName.length + 1);
            const email = token ? await env.OAUTH_KV.get(`session:${await sha256(token)}`) : null;
            if (url.pathname === "/login") {
              if (request.method === "GET")
                return form(
                  "Log in",
                  '<label>Email address <input name="email" type="email" autocomplete="email" required></label>',
                  "Log in",
                );
              if (request.method !== "POST") return new Response("POST required", { status: 405 });
              if (origin !== url.origin) return new Response("Origin required", { status: 403 });
              const parsed = z
                .email()
                .max(254)
                .safeParse((await request.formData()).get("email"));
              if (!parsed.success) return new Response("Enter an email address", { status: 400 });
              const next = new URL(url.searchParams.get("next") ?? "/", url);
              if (next.origin !== url.origin)
                return new Response("Invalid return URL", { status: 400 });
              const fresh = crypto.randomUUID() + crypto.randomUUID();
              await env.OAUTH_KV.put(`session:${await sha256(fresh)}`, parsed.data, {
                expirationTtl: 86400,
              });
              return redirect(
                next.href,
                `${cookieName}=${fresh}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`,
              );
            }
            if (!email) {
              if (url.pathname === "/" || url.pathname === "/authorize")
                return redirect(
                  url.pathname === "/"
                    ? "/login"
                    : `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
                );
              return new Response("Log in at /login", { status: 401 });
            }
            if (url.pathname === "/session")
              return Response.json(
                { email, verified: false },
                { headers: { "cache-control": "no-store" } },
              );
            if (url.pathname === "/authorize") {
              try {
                const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
                if (!auth.scope.includes("project"))
                  return new Response("Request the project scope", { status: 400 });
                if (request.method === "GET")
                  return form(
                    "Authorize MCP",
                    `<p>${escape(auth.clientId)} requests project access as ${escape(email)}.</p><label>Project <input name="project" required pattern="[a-zA-Z0-9_-]{1,80}"></label>`,
                    "Allow project access",
                  );
                if (request.method !== "POST" || origin !== url.origin)
                  return new Response("Same-origin POST required", { status: 403 });
                const project = address(
                  String((await request.formData()).get("project") ?? ""),
                ).project;
                const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
                  request: auth,
                  userId: email,
                  metadata: {},
                  scope: ["project"],
                  props: { email, project },
                });
                return Response.redirect(redirectTo, 302);
              } catch (error) {
                if (error instanceof Fault)
                  return new Response(error.message, { status: error.status });
                if (!(error instanceof AuthorizationError)) throw error;
                return new Response(error.description, { status: 400 });
              }
            }
            const clean = new Request(request);
            clean.headers.delete("cookie");
            return core.fetch(clean, env, ctx);
          },
        },
      });
      return provider.fetch(request, env, ctx);
    },
  };
}
