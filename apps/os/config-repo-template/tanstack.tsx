import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { IterateWorkerEntrypoint } from "iterate/sdk";

// A tiny server-rendered TanStack + React app behind project-member auth,
// served at tanstack--<project>.<base>. Every request builds a router and
// renders it to HTML in the worker — no client bundle, no hydration: the
// worker build pipeline is npm + wrangler's bundler, so the full TanStack
// Start toolchain (a Vite plugin) has nowhere to run. What this keeps from
// Start is the shape: routes matched from the request path, an SSR document
// per navigation, and a place hydration can later attach (see
// tasks/tanstack-start-ssr-capnweb-bootstrap-ticket.md).
//
// Navigation is plain anchors and the routes close over their data instead of
// using `Link`/`useRouteContext`: those APIs type against the one GLOBAL
// TanStack `Register` (the OS dashboard's router, in the repo this template
// typechecks inside), and without client-side routing `Link` renders an
// anchor anyway.
function buildRouter(input: { pathname: string; projectId: string; projectName: string }) {
  const rootRoute = createRootRoute({
    component: () => (
      <main>
        <h1>TanStack on Iterate</h1>
        <nav>
          <a href="/">home</a> · <a href="/about">about</a>
        </nav>
        <Outlet />
      </main>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <section>
        <p>
          Serving project <strong>{input.projectName}</strong> (<code>{input.projectId}</code>) to a
          signed-in member.
        </p>
        <p>This page is React, routed by TanStack Router and rendered in your project worker.</p>
      </section>
    ),
  });
  const aboutRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/about",
    component: () => (
      <section>
        <p>
          Server-side routing proof: this is a second route, matched from the request path and
          rendered by the same router. Edit tanstack.tsx in the project repo to change it.
        </p>
      </section>
    ),
  });
  return createRouter({
    history: createMemoryHistory({ initialEntries: [input.pathname] }),
    routeTree: rootRoute.addChildren([indexRoute, aboutRoute]),
  });
}

// A project-member-only SSR app. The auth partial owns login/callback/logout
// exactly as in InternalApp (worker.ts); a null result means this request is
// a current project member. WHO the member is deliberately stays out of the
// page lane: `auth.authenticate` is the explicit exchange for an app's
// Cap'n Web root and requires a browser handshake's Origin header, which
// top-level GET navigations never send — see InternalApp's /api for that
// pattern.
export class TanstackApp extends IterateWorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const gate = itx.auth.get({ policy: "project-member" });
    const authResponse = await gate.fetch(request);
    if (authResponse) return authResponse;
    const identity = await itx.identity();

    const url = new URL(request.url);
    const prefix = request.headers.get("x-iterate-url-prefix") ?? "";
    const pathname = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length) || "/"
      : url.pathname;
    const router = buildRouter({
      pathname,
      projectId: identity.projectId,
      projectName: identity.name,
    });
    await router.load();

    const body = renderToString(<RouterProvider router={router} />);
    return new Response(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <title>TanStack on Iterate</title>
  </head>
  <body>
    ${body}
    <form action="${escapeHtml(`${prefix}/_iterate/auth/logout`)}" method="post"><button>Sign out</button></form>
  </body>
</html>`,
      {
        headers: {
          "cache-control": "no-store",
          // SSR-only: no scripts at all, so the policy can say so.
          "content-security-policy":
            "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
