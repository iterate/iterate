import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getServerInfo = createServerFn({ method: "GET" }).handler(async () => {
  // This runs server-side inside the Durable Object
  const now = new Date();
  return {
    time: now.toISOString(),
    timestamp: now.getTime(),
    runtime:
      typeof navigator !== "undefined"
        ? (navigator as any).userAgent || "Cloudflare Workers"
        : "unknown",
    // Prove we're in a worker environment
    hasGlobalFetch: typeof fetch === "function",
    hasCrypto: typeof crypto !== "undefined",
    hasReadableStream: typeof ReadableStream !== "undefined",
    mathRandom: Math.random(),
  };
});

export const Route = createFileRoute("/")({
  loader: async () => {
    return getServerInfo();
  },
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();

  return (
    <main>
      <h1>TanStack Start in a Durable Facet</h1>
      <p>
        This is a full TanStack Start app with SSR, file-based routing, and server functions — all
        running inside a Cloudflare Durable Object via the nested-facets dynamic worker system.
      </p>
      <p>
        The HTML you see was <strong>server-side rendered</strong> inside the DO, then streamed to
        the browser and hydrated with client-side React.
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        Server Info (from SSR loader)
      </h2>
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "1rem",
          fontFamily: "monospace",
          fontSize: "0.85rem",
          lineHeight: 1.8,
        }}
      >
        <div>
          <span style={{ color: "#888" }}>Server time:</span>{" "}
          <span style={{ color: "#4ade80" }}>{data.time}</span>
        </div>
        <div>
          <span style={{ color: "#888" }}>Timestamp:</span> {data.timestamp}
        </div>
        <div>
          <span style={{ color: "#888" }}>Runtime:</span> {data.runtime}
        </div>
        <div>
          <span style={{ color: "#888" }}>Random:</span> {data.mathRandom}
        </div>
        <div>
          <span style={{ color: "#888" }}>fetch:</span> {data.hasGlobalFetch ? "yes" : "no"}
        </div>
        <div>
          <span style={{ color: "#888" }}>crypto:</span> {data.hasCrypto ? "yes" : "no"}
        </div>
        <div>
          <span style={{ color: "#888" }}>ReadableStream:</span>{" "}
          {data.hasReadableStream ? "yes" : "no"}
        </div>
      </div>

      <p style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
        Refresh the page — the server time and random number will change (SSR, not cached). Navigate
        to{" "}
        <a href="/server-fns" style={{ color: "#60a5fa" }}>
          /server-fns
        </a>{" "}
        for interactive server function demos.
      </p>
    </main>
  );
}
