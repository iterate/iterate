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

const platformServices = [
  {
    label: "Events Service",
    host: "events.iterate.localhost",
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

const services = [
  {
    label: "Orders Service",
    host: "orders.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsPath: "/api/docs",
  },
] as const;

function buildHomeHtml(): string {
  const platformLinksJson = JSON.stringify(platformLinks).replaceAll("<", "\\u003c");
  const platformServicesJson = JSON.stringify(platformServices).replaceAll("<", "\\u003c");
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
        font-family:
          "SF Pro Display",
          "Segoe UI",
          "Inter",
          ui-sans-serif,
          system-ui,
          -apple-system,
          sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: #f7f8fb;
        color: #111827;
      }
      main {
        margin: 0 auto;
        max-width: 76rem;
        padding: 2rem 1.25rem;
      }
      h1 {
        margin: 0;
        font-size: 1.875rem;
        line-height: 1.2;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0.4rem 0 1.25rem 0;
        color: #4b5563;
        font-size: 1rem;
      }
      .columns {
        display: grid;
        gap: 1.25rem;
      }
      .column {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 0.75rem;
        padding: 1rem 1rem 1.1rem 1rem;
      }
      .column h2 {
        margin: 0 0 0.75rem 0;
        font-size: 0.78rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6b7280;
        font-weight: 700;
      }
      .platform-list,
      .service-list {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .section-label {
        margin: 0.9rem 0 0.25rem 0;
        font-size: 0.72rem;
        letter-spacing: 0.11em;
        text-transform: uppercase;
        color: #6b7280;
        font-weight: 700;
      }
      .platform-item,
      .service-item {
        padding: 0.7rem 0;
        border-top: 1px solid #eef0f4;
      }
      .platform-item:first-child,
      .service-item:first-child {
        border-top: 0;
        padding-top: 0.2rem;
      }
      .platform-label {
        display: block;
        margin-bottom: 0.2rem;
        font-size: 1rem;
        font-weight: 650;
      }
      .platform-hint {
        margin-bottom: 0.25rem;
        font-size: 0.83rem;
        color: #374151;
      }
      .service-name {
        margin: 0 0 0.45rem 0;
        font-size: 1.02rem;
        font-weight: 650;
      }
      .service-rows {
        display: grid;
        gap: 0.35rem;
      }
      .service-row {
        display: grid;
        grid-template-columns: 6rem minmax(0, 1fr);
        gap: 0.6rem;
        align-items: center;
      }
      .row-label {
        font-size: 0.74rem;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: #6b7280;
        font-weight: 700;
      }
      .url-line {
        display: block;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.94rem;
        color: #111827;
        text-decoration: none;
      }
      a.url-line:hover {
        text-decoration: underline;
      }
      .row-empty {
        color: #6b7280;
        font-size: 0.94rem;
      }
      @media (min-width: 980px) {
        .columns {
          grid-template-columns: 0.95fr 2.05fr;
          align-items: start;
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
          <ul id="platform-links" class="platform-list" aria-label="Platform links"></ul>
          <p class="section-label">Platform Services</p>
          <ul id="platform-service-list" class="service-list" aria-label="Platform services"></ul>
        </section>
        <section class="column">
          <h2>Services</h2>
          <ul id="service-list" class="service-list" aria-label="Service links"></ul>
        </section>
      </div>
    </main>
    <script>
      const platformLinks = ${platformLinksJson};
      const platformServices = ${platformServicesJson};
      const services = ${servicesJson};
      const port = window.location.port ? ":" + window.location.port : "";
      const protocol = window.location.protocol || "http:";
      const hrefFor = (host, path) => protocol + "//" + host + port + path;

      const platformList = document.getElementById("platform-links");
      platformList.innerHTML = platformLinks.map((item) => {
        const href = hrefFor(item.host, item.path);
        const hint = item.hint ? "<div class=\\\"platform-hint\\\">" + item.hint + "</div>" : "";
        return "<li class=\\\"platform-item\\\"><span class=\\\"platform-label\\\">" + item.label + "</span>" + hint + "<a class=\\\"url-line\\\" href=\\\"" + href + "\\\" title=\\\"" + href + "\\\">" + href + "</a></li>";
      }).join("");

      const renderRow = (name, host, path, emptyText) => {
        const value = path
          ? "<a class=\\\"url-line\\\" href=\\\"" + hrefFor(host, path) + "\\\" title=\\\"" + hrefFor(host, path) + "\\\">" + hrefFor(host, path) + "</a>"
          : "<span class=\\\"row-empty\\\">" + (emptyText || "n/a") + "</span>";
        return "<div class=\\\"service-row\\\"><span class=\\\"row-label\\\">" + name + "</span>" + value + "</div>";
      };

      const renderServiceItem = (service) => {
        return "<li class=\\\"service-item\\\"><h3 class=\\\"service-name\\\">" + service.label + "</h3><div class=\\\"service-rows\\\">"
          + renderRow("Frontend", service.host, service.frontendPath, service.frontendHint || "has no frontend")
          + renderRow("API", service.host, service.apiPath, service.apiHint || "has no api")
          + renderRow("Docs", service.host, service.docsPath, service.docsHint || "has no docs")
          + "</div></li>";
      };

      const platformServiceList = document.getElementById("platform-service-list");
      platformServiceList.innerHTML = platformServices.map(renderServiceItem).join("");

      const serviceList = document.getElementById("service-list");
      serviceList.innerHTML = services.map(renderServiceItem).join("");
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
