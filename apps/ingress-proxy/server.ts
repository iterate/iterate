import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import packageJson from "./package.json" with { type: "json" };
import { buildUpstreamUrl, createUpstreamHeaders } from "./proxy.ts";
import { listAllRoutes, resolveRouteByHost } from "./route-store.ts";
import { ingressProxyRouter } from "./router.ts";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDebugPage(params: {
  routes: Awaited<ReturnType<typeof listAllRoutes>>["routes"];
  total: number;
}): string {
  const routeCards = params.routes
    .map((route) => {
      const metadata = JSON.stringify(route.metadata, null, 2);

      return `
        <article class="route-card">
          <div class="route-topline">
            <code>${escapeHtml(route.rootHost)}</code>
            <span class="route-id">${escapeHtml(route.id)}</span>
          </div>
          <p class="route-target">${escapeHtml(route.targetUrl)}</p>
          <dl class="route-meta">
            <div><dt>created</dt><dd>${escapeHtml(route.createdAt)}</dd></div>
            <div><dt>updated</dt><dd>${escapeHtml(route.updatedAt)}</dd></div>
          </dl>
          <details>
            <summary>metadata</summary>
            <pre>${escapeHtml(metadata)}</pre>
          </details>
        </article>
      `;
    })
    .join("");

  const body =
    params.routes.length > 0
      ? routeCards
      : `<p class="empty-state">No ingress routes are currently registered.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ingress Proxy Debug</title>
    <style>
      :root {
        color-scheme: dark;
        font-family:
          ui-sans-serif,
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        background: #0b1020;
        color: #f8fafc;
      }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(59, 130, 246, 0.18), transparent 28%),
          linear-gradient(180deg, #0b1020 0%, #111827 100%);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 32px;
      }
      .lede {
        margin: 0 0 24px;
        color: #cbd5e1;
        max-width: 70ch;
        line-height: 1.5;
      }
      .warning {
        margin: 0 0 24px;
        padding: 12px 14px;
        border: 1px solid rgba(250, 204, 21, 0.35);
        border-radius: 12px;
        background: rgba(120, 53, 15, 0.28);
        color: #fde68a;
      }
      .summary {
        margin: 0 0 20px;
        color: #93c5fd;
      }
      .route-list {
        display: grid;
        gap: 16px;
      }
      .route-card {
        padding: 16px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.92);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.25);
      }
      .route-topline {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px 16px;
        align-items: baseline;
      }
      code,
      pre,
      .route-id {
        font-family:
          ui-monospace,
          SFMono-Regular,
          SFMono-Regular,
          Menlo,
          monospace;
      }
      code {
        font-size: 16px;
        color: #f8fafc;
      }
      .route-id {
        color: #93c5fd;
        font-size: 13px;
      }
      .route-target {
        margin: 10px 0 12px;
        color: #cbd5e1;
        word-break: break-all;
      }
      .route-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px 16px;
        margin: 0 0 12px;
      }
      .route-meta div {
        display: grid;
        gap: 2px;
      }
      dt {
        color: #94a3b8;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      dd {
        margin: 0;
        color: #e2e8f0;
      }
      details summary {
        cursor: pointer;
        color: #93c5fd;
      }
      pre {
        margin: 10px 0 0;
        padding: 12px;
        overflow-x: auto;
        border-radius: 12px;
        background: rgba(2, 6, 23, 0.8);
        color: #cbd5e1;
      }
      .empty-state {
        padding: 16px;
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.92);
        color: #cbd5e1;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Ingress Proxy Debug</h1>
      <p class="lede">
        Currently active routes from the production D1 registry. This is a simple
        operator-facing page for now so we can quickly inspect the root host to
        target mapping that the worker is serving.
      </p>
      <p class="warning">
        This page is intentionally temporary and should sit behind auth.iterate.com eventually.
      </p>
      <p class="summary">${params.total} active route${params.total === 1 ? "" : "s"}</p>
      <section class="route-list">
        ${body}
      </section>
    </main>
  </body>
</html>`;
}

export async function proxyRequest(request: Request): Promise<Response> {
  const resolved = await resolveRouteByHost(env.DB, request.headers.get("host"));
  if (!resolved) {
    return jsonError(404, "route_not_found");
  }

  const inboundUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(resolved.targetUrl, inboundUrl);
  let upstreamRequest: Request = new Request(upstreamUrl.toString(), request);
  const upstreamHeaders = createUpstreamHeaders(upstreamRequest, resolved.targetUrl);
  upstreamRequest = new Request(upstreamRequest, { headers: upstreamHeaders });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest, { redirect: "manual" });
  } catch {
    return jsonError(502, "proxy_error");
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("x-cf-proxy-root-host", resolved.route.rootHost);
  responseHeaders.set("x-cf-proxy-route-id", resolved.route.id);

  if (upstreamResponse.status === 101) {
    const init = {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
      webSocket: (upstreamResponse as Response & { webSocket?: WebSocket | null }).webSocket,
    };
    return new Response(null, init as ResponseInit);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

const openAPIHandler = new OpenAPIHandler(ingressProxyRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Ingress Proxy API",
          version: packageJson.version ?? "0.0.0",
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

export const app = new Hono<{
  Bindings: {};
}>();

app.get("/health", (c) => c.text("OK"));

app.get("/__debug", async (c) => {
  const result = await listAllRoutes(env.DB);
  return c.html(
    renderDebugPage({
      routes: result.routes,
      total: result.total,
    }),
  );
});

app.all("/api/*", async (c) => {
  const { matched, response } = await openAPIHandler.handle(c.req.raw, {
    prefix: "/api",
    context: {
      request: c.req.raw,
    },
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  return c.json({ error: "not_found" }, 404);
});

app.all("*", async (c) => {
  return proxyRequest(c.req.raw);
});

export default app;
