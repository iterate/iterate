import { createServer } from "node:http";

const rawPort = process.env.HOME_SERVICE_PORT ?? "19030";
const port = Number.parseInt(rawPort, 10);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid HOME_SERVICE_PORT: ${rawPort}`);
}

const platformLinks = [
  { label: "Home", host: "home.iterate.localhost", path: "/" },
  {
    label: "OpenObserve",
    host: "openobserve.iterate.localhost",
    path: "/",
    hint: "login: root@example.com / Complexpass#123",
  },
  { label: "ClickStack", host: "clickstack.iterate.localhost", path: "/" },
] as const;

const services = [
  {
    label: "Events Service",
    host: "events.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsPath: "/api/docs",
  },
  {
    label: "Orders Service",
    host: "orders.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsPath: "/api/docs",
  },
  {
    label: "Services Service",
    host: "services.iterate.localhost",
    apiPath: "/rpc/service/health",
    frontendHint: "has no frontend",
    docsHint: "has no docs",
  },
  {
    label: "Home Service",
    host: "home.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsHint: "has no docs",
  },
  {
    label: "Outerbase Service",
    host: "outerbase.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsHint: "has no docs",
  },
] as const;

function buildHomeHtml(): string {
  const platformLinksJson = JSON.stringify(platformLinks).replaceAll("<", "\\u003c");
  const servicesJson = JSON.stringify(services).replaceAll("<", "\\u003c");
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
        max-width: 72rem;
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
      h2 {
        margin: 0 0 0.75rem 0;
        font-size: 1rem;
      }
      .columns {
        display: grid;
        gap: 1rem;
      }
      .column {
        border: 1px solid #cbd5e1;
        border-radius: 0.75rem;
        background: white;
        padding: 1rem;
      }
      .platform-list {
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
        list-style: none;
      }
      .platform-link {
        display: block;
        border: 1px solid #cbd5e1;
        border-radius: 0.5rem;
        background: white;
        padding: 0.625rem 0.75rem;
        color: inherit;
        text-decoration: none;
      }
      .platform-link:hover {
        background: #f1f5f9;
      }
      .platform-link strong {
        display: block;
      }
      .service-list {
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.75rem;
      }
      .service-card {
        border: 1px solid #cbd5e1;
        border-radius: 0.5rem;
        padding: 0.75rem;
        background: #ffffff;
      }
      .service-name {
        margin: 0 0 0.5rem 0;
        font-size: 0.95rem;
      }
      .slots {
        display: grid;
        gap: 0.5rem;
      }
      .slot {
        border: 1px solid #e2e8f0;
        border-radius: 0.5rem;
        padding: 0.5rem;
      }
      .slot-name {
        font-size: 0.75rem;
        text-transform: uppercase;
        color: #64748b;
        margin-bottom: 0.25rem;
      }
      .slot a {
        color: #0f172a;
        text-decoration: none;
      }
      .slot a:hover {
        text-decoration: underline;
      }
      .slot-empty {
        color: #64748b;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      @media (min-width: 960px) {
        .columns {
          grid-template-columns: 1fr 2fr;
          align-items: start;
        }
        .slots {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>jonasland5</h1>
      <p>Lightweight local browser index.</p>
      <div class="columns">
        <section class="column">
          <h2>Platform</h2>
          <ul id="platform-links" class="platform-list"></ul>
        </section>
        <section class="column">
          <h2>Services</h2>
          <div id="service-list" class="service-list"></div>
        </section>
      </div>
    </main>
    <script>
      const platformLinks = ${platformLinksJson};
      const services = ${servicesJson};
      const port = window.location.port ? ":" + window.location.port : "";
      const protocol = window.location.protocol || "http:";
      const hrefFor = (host, path) => protocol + "//" + host + port + path;

      const platformList = document.getElementById("platform-links");
      platformList.innerHTML = platformLinks.map((item) => {
        const href = hrefFor(item.host, item.path);
        const hint = item.hint ? "<code>" + item.hint + "</code><br>" : "";
        return "<li><a class=\\\"platform-link\\\" href=\\\"" + href + "\\\"><strong>" + item.label + "</strong>" + hint + "<code>" + href + "</code></a></li>";
      }).join("");

      const renderSlot = (name, host, path, emptyText) => {
        const value = path
          ? "<a href=\\\"" + hrefFor(host, path) + "\\\"><code>" + hrefFor(host, path) + "</code></a>"
          : "<span class=\\\"slot-empty\\\">" + (emptyText || "n/a") + "</span>";
        return "<div class=\\\"slot\\\"><div class=\\\"slot-name\\\">" + name + "</div>" + value + "</div>";
      };

      const serviceList = document.getElementById("service-list");
      serviceList.innerHTML = services.map((service) => {
        return "<article class=\\\"service-card\\\"><h3 class=\\\"service-name\\\">" + service.label + "</h3><div class=\\\"slots\\\">"
          + renderSlot("Frontend", service.host, service.frontendPath, service.frontendHint || "has no frontend")
          + renderSlot("API", service.host, service.apiPath, service.apiHint || "has no api")
          + renderSlot("Docs", service.host, service.docsPath, service.docsHint || "has no docs")
          + "</div></article>";
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
