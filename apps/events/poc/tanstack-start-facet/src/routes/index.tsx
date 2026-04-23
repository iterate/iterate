import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getInfo = createServerFn({ method: "GET" }).handler(async () => ({
  time: new Date().toISOString(),
  runtime: typeof navigator !== "undefined" ? (navigator as any).userAgent : "unknown",
  features: ["SSR", "oRPC", "OpenAPI + Scalar", "Streaming (SSE)", "SQLite CRUD"],
}));

export const Route = createFileRoute("/")({
  loader: () => getInfo(),
  component: () => {
    const data = Route.useLoaderData();
    return (
      <main>
        <h1>oRPC + TanStack Start</h1>
        <p>
          Full-stack app running on Cloudflare Workers with oRPC typed API, streaming, and Scalar
          docs.
        </p>
        <pre>{JSON.stringify(data, null, 2)}</pre>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <a href="/api/docs" target="_blank">
            <button>API Docs (Scalar)</button>
          </a>
          <a href="/api/openapi.json" target="_blank">
            <button>OpenAPI Spec</button>
          </a>
          <a href="/api/ping">
            <button>GET /api/ping</button>
          </a>
        </div>
      </main>
    );
  },
});
