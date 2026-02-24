import { createServer } from "node:http";

const rawPort = process.env.HOME_SERVICE_PORT ?? "19030";
const port = Number.parseInt(rawPort, 10);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid HOME_SERVICE_PORT: ${rawPort}`);
}

const links = [
  { label: "Home", host: "home.iterate.localhost", path: "/" },
  { label: "Events API", host: "events.iterate.localhost", path: "/api/events?limit=20&offset=0" },
  { label: "Events Docs", host: "events.iterate.localhost", path: "/api/docs" },
  { label: "Orders API", host: "orders.iterate.localhost", path: "/api/orders?limit=20&offset=0" },
  { label: "Orders Docs", host: "orders.iterate.localhost", path: "/api/docs" },
  { label: "Services API", host: "services.iterate.localhost", path: "/rpc/service/health" },
  { label: "Outerbase", host: "outerbase.iterate.localhost", path: "/" },
  { label: "OpenObserve", host: "openobserve.iterate.localhost", path: "/" },
  { label: "ClickStack", host: "clickstack.iterate.localhost", path: "/" },
  { label: "Caddy Admin", host: "caddy-admin.iterate.localhost", path: "/config/" },
  { label: "Pidnap", host: "pidnap.iterate.localhost", path: "/rpc/processes/list" },
] as const;

function buildHomeHtml(): string {
  const linksJson = JSON.stringify(links).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jonasland5 Home</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: #f8fafc;
        color: #0f172a;
      }
      main {
        margin: 0 auto;
        max-width: 48rem;
        padding: 1.5rem;
      }
      h1 {
        margin: 0 0 0.5rem 0;
        font-size: 1.25rem;
      }
      p {
        margin: 0 0 1rem 0;
        color: #475569;
      }
      ul {
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
        list-style: none;
      }
      a {
        display: block;
        border: 1px solid #cbd5e1;
        border-radius: 0.5rem;
        background: white;
        padding: 0.625rem 0.75rem;
        color: inherit;
        text-decoration: none;
      }
      a:hover {
        background: #f1f5f9;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>jonasland5</h1>
      <p>Lightweight local service index.</p>
      <ul id="links"></ul>
    </main>
    <script>
      const links = ${linksJson};
      const port = window.location.port ? ":" + window.location.port : "";
      const protocol = window.location.protocol || "http:";
      const list = document.getElementById("links");
      list.innerHTML = links.map((item) => {
        const href = protocol + "//" + item.host + port + item.path;
        return "<li><a href=\\\"" + href + "\\\"><strong>" + item.label + "</strong><br><code>" + href + "</code></a></li>";
      }).join("");
    </script>
  </body>
</html>`;
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && pathname === "/api/observability") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ otel: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null }));
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(buildHomeHtml());
    return;
  }

  res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
});

server.listen(port, "0.0.0.0");

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
