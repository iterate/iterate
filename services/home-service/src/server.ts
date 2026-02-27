import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
} from "@iterate-com/shared/jonasland";

const serviceName = "jonasland-home-service";

const platformLinks = [
  { label: "Home", host: "home.iterate.localhost", path: "/" },
  { label: "Docs", host: "docs.iterate.localhost", path: "/" },
  { label: "OpenCode", host: "opencode.iterate.localhost", path: "/" },
  {
    label: "OpenObserve",
    host: "openobserve.iterate.localhost",
    path: "/",
    hint: "login: root@example.com / Complexpass#123",
  },
  { label: "ClickStack", host: "clickstack.iterate.localhost", path: "/" },
  { label: "Caddy Manager", host: "caddymanager.iterate.localhost", path: "/" },
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
    label: "Registry Service",
    host: "registry.iterate.localhost",
    apiPath: "/orpc/service/health",
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
    label: "Daemon Service",
    host: "daemon.iterate.localhost",
    apiPath: "/healthz",
    frontendHint: "has no frontend",
    docsPath: "/api/docs",
  },
  {
    label: "OpenCode Wrapper Service",
    host: "opencode-wrapper.iterate.localhost",
    apiPath: "/healthz",
    frontendHint: "has no frontend",
    docsPath: "/api/docs",
  },
  {
    label: "OpenCode Service",
    host: "opencode.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsHint: "docs not exposed",
  },
  {
    label: "Agents Service",
    host: "agents.iterate.localhost",
    apiPath: "/healthz",
    frontendHint: "has no frontend",
    docsPath: "/api/docs",
  },
  {
    label: "Slack Service",
    host: "slack.iterate.localhost",
    apiPath: "/healthz",
    frontendHint: "has no frontend",
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
    label: "Docs Service",
    host: "docs.iterate.localhost",
    frontendPath: "/",
    apiPath: "/healthz",
    docsHint: "aggregates openapi specs",
  },
] as const;

function parsePort(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key}: ${value}`);
  }
  return parsed;
}

function getEnv() {
  const rawHost = process.env.HOME_SERVICE_HOST?.trim();
  return {
    host: rawHost && rawHost.length > 0 ? rawHost : "0.0.0.0",
    port: parsePort(
      process.env.HOME_SERVICE_PORT ?? process.env.PORT ?? "19030",
      "HOME_SERVICE_PORT",
    ),
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function buildHomeHtml(): string {
  const platformLinksJson = JSON.stringify(platformLinks).replaceAll("<", "\\u003c");
  const platformServicesJson = JSON.stringify(platformServices).replaceAll("<", "\\u003c");
  const servicesJson = JSON.stringify(services).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jonasland Home</title>
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
      <h1>jonasland</h1>
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
        const hint = item.hint ? '<div class="platform-hint">' + item.hint + "</div>" : "";
        return '<li class="platform-item"><span class="platform-label">' + item.label + "</span>" + hint + '<a class="url-line" href="' + href + '" title="' + href + '">' + href + "</a></li>";
      }).join("");

      const renderRow = (name, host, path, emptyText) => {
        const value = path
          ? '<a class="url-line" href="' + hrefFor(host, path) + '" title="' + hrefFor(host, path) + '">' + hrefFor(host, path) + "</a>"
          : '<span class="row-empty">' + (emptyText || "n/a") + "</span>";
        return '<div class="service-row"><span class="row-label">' + name + "</span>" + value + "</div>";
      };

      const renderServiceItem = (service) => {
        return '<li class="service-item"><h3 class="service-name">' + service.label + '</h3><div class="service-rows">'
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

export async function startHomeService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const env = getEnv();
  const host = options?.host ?? env.host;
  const port = options?.port ?? env.port;

  initializeServiceOtel(serviceName);
  initializeServiceEvlog(serviceName);

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const requestLog = createServiceRequestLogger({
      requestId,
      method: req.method,
      path: req.url,
    });
    const startedAt = Date.now();
    let status = 500;

    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (req.method === "GET" && pathname === "/healthz") {
        status = 200;
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (req.method === "GET" && pathname === "/api/observability") {
        status = 200;
        writeJson(res, status, {
          otel: getOtelRuntimeConfig(),
        });
        return;
      }

      if (req.method === "GET") {
        status = 200;
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(buildHomeHtml());
        return;
      }

      status = 405;
      writeJson(res, status, { error: "method_not_allowed" });
    } catch (error) {
      status = 500;
      requestLog.error(toError(error));
      writeJson(res, status, { error: "internal_error" });
    } finally {
      requestLog.emit({
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host,
    port,
    ui_path: "/",
    health_path: "/healthz",
    observability_path: "/api/observability",
    otel: getOtelRuntimeConfig(),
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startHomeService()
    .then((runtime) => {
      const shutdown = () => {
        void runtime
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };

      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    })
    .catch(() => {
      process.exit(1);
    });
}
