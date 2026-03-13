import type { ServiceAppEnv } from "@iterate-com/shared/jonasland";
import { createNodeWebSocket } from "@hono/node-ws";
import { createRegistryClient } from "@iterate-com/registry";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceOpenAPIHandler,
  createSimpleServiceRouter,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";

const serviceName = "jonasland-home-service";

type LinkSeed = {
  label: string;
  host: string;
  path: string;
  hint?: string;
};

type ServiceSeed = {
  label: string;
  host: string;
  frontendPath?: string;
  apiPath?: string;
  docsPath?: string;
  frontendHint?: string;
  apiHint?: string;
  docsHint?: string;
};

type RenderLink = {
  label: string;
  href: string;
  hint?: string;
};

type RenderService = {
  label: string;
  frontendURL?: string;
  apiURL?: string;
  docsURL?: string;
  frontendHint?: string;
  apiHint?: string;
  docsHint?: string;
};

type RouteRecord = Awaited<
  ReturnType<ReturnType<typeof createRegistryClient>["routes"]["list"]>
>["routes"][number];

const platformLinks: ReadonlyArray<LinkSeed> = [
  { label: "Home", host: "home.iterate.localhost", path: "/" },
  { label: "Docs", host: "docs.iterate.localhost", path: "/" },
  {
    label: "OpenObserve",
    host: "openobserve.iterate.localhost",
    path: "/",
    hint: "login: root@example.com / Complexpass#123",
  },
  { label: "ClickStack", host: "clickstack.iterate.localhost", path: "/" },
] as const;

const platformServices: ReadonlyArray<ServiceSeed> = [
  {
    label: "Events Service",
    host: "events.iterate.localhost",
    frontendPath: "/",
    apiPath: "/api/__iterate/health",
    docsPath: "/api/docs",
  },
  {
    label: "Registry Service",
    host: "registry.iterate.localhost",
    apiPath: "/api/__iterate/health",
    frontendHint: "has no frontend",
    docsHint: "has no docs",
  },
  {
    label: "Home Service",
    host: "home.iterate.localhost",
    frontendPath: "/",
    apiPath: "/api/__iterate/health",
    docsHint: "has no docs",
  },
  {
    label: "Outerbase Service",
    host: "outerbase.iterate.localhost",
    frontendPath: "/",
    apiPath: "/api/__iterate/health",
    docsHint: "has no docs",
  },
] as const;

const services: ReadonlyArray<ServiceSeed> = [
  {
    label: "Example Service",
    host: "example.iterate.localhost",
    frontendPath: "/",
    apiPath: "/api/__iterate/health",
    docsPath: "/api/docs",
  },
  {
    label: "Docs Service",
    host: "docs.iterate.localhost",
    frontendPath: "/",
    apiPath: "/api/__iterate/health",
    docsHint: "aggregates openapi specs",
  },
] as const;

function getEnv() {
  const rawHost = process.env.HOME_SERVICE_HOST?.trim();
  const registryUrl = process.env.ITERATE_REGISTRY_URL?.trim();
  return {
    host: rawHost && rawHost.length > 0 ? rawHost : "0.0.0.0",
    registryOrpcURL: registryUrl && registryUrl.length > 0 ? registryUrl : null,
  };
}

function toInternalURL(host: string, path: string): string {
  return `http://${host}${path}`;
}

async function resolvePublicURL(
  registry: ReturnType<typeof createRegistryClient>,
  internalURL: string,
): Promise<string> {
  const resolved = await registry.getPublicURL({ internalURL });
  return resolved.publicURL;
}

async function resolveLink(
  registry: ReturnType<typeof createRegistryClient>,
  link: LinkSeed,
): Promise<RenderLink> {
  const internalURL = toInternalURL(link.host, link.path);
  return {
    label: link.label,
    href: await resolvePublicURL(registry, internalURL),
    ...(link.hint ? { hint: link.hint } : {}),
  };
}

async function resolveService(
  registry: ReturnType<typeof createRegistryClient>,
  service: ServiceSeed,
): Promise<RenderService> {
  const frontendURL =
    service.frontendPath === undefined
      ? undefined
      : await resolvePublicURL(registry, toInternalURL(service.host, service.frontendPath));
  const apiURL =
    service.apiPath === undefined
      ? undefined
      : await resolvePublicURL(registry, toInternalURL(service.host, service.apiPath));
  const docsURL =
    service.docsPath === undefined
      ? undefined
      : await resolvePublicURL(registry, toInternalURL(service.host, service.docsPath));

  return {
    label: service.label,
    ...(frontendURL ? { frontendURL } : {}),
    ...(apiURL ? { apiURL } : {}),
    ...(docsURL ? { docsURL } : {}),
    ...(service.frontendHint ? { frontendHint: service.frontendHint } : {}),
    ...(service.apiHint ? { apiHint: service.apiHint } : {}),
    ...(service.docsHint ? { docsHint: service.docsHint } : {}),
  };
}

async function resolveHomeData(registry: ReturnType<typeof createRegistryClient>): Promise<{
  platformLinks: RenderLink[];
  platformServices: RenderService[];
  services: RenderService[];
  routes: RouteRecord[];
}> {
  const [resolvedPlatformLinks, resolvedPlatformServices, resolvedServices, routesResult] =
    await Promise.all([
      Promise.all(platformLinks.map((link) => resolveLink(registry, link))),
      Promise.all(platformServices.map((service) => resolveService(registry, service))),
      Promise.all(services.map((service) => resolveService(registry, service))),
      registry.routes.list({}),
    ]);

  return {
    platformLinks: resolvedPlatformLinks,
    platformServices: resolvedPlatformServices,
    services: resolvedServices,
    routes: routesResult.routes,
  };
}

function buildHomeHtml(data: {
  platformLinks: RenderLink[];
  platformServices: RenderService[];
  services: RenderService[];
  routes: RouteRecord[];
}): string {
  const platformLinksJson = JSON.stringify(data.platformLinks).replaceAll("<", "\\u003c");
  const platformServicesJson = JSON.stringify(data.platformServices).replaceAll("<", "\\u003c");
  const servicesJson = JSON.stringify(data.services).replaceAll("<", "\\u003c");
  const routesJson = JSON.stringify(data.routes).replaceAll("<", "\\u003c");
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
          <p class="section-label">Registry Routes</p>
          <ul id="route-list" class="service-list" aria-label="Registry routes"></ul>
        </section>
      </div>
    </main>
    <script>
      const platformLinks = ${platformLinksJson};
      const platformServices = ${platformServicesJson};
      const services = ${servicesJson};
      const routes = ${routesJson};

      const platformList = document.getElementById("platform-links");
      platformList.innerHTML = platformLinks.map((item) => {
        const hint = item.hint ? '<div class="platform-hint">' + item.hint + "</div>" : "";
        return '<li class="platform-item"><span class="platform-label">' + item.label + "</span>" + hint + '<a class="url-line" href="' + item.href + '" title="' + item.href + '">' + item.href + "</a></li>";
      }).join("");

      const renderRow = (name, url, emptyText) => {
        const value = url
          ? '<a class="url-line" href="' + url + '" title="' + url + '">' + url + "</a>"
          : '<span class="row-empty">' + (emptyText || "n/a") + "</span>";
        return '<div class="service-row"><span class="row-label">' + name + "</span>" + value + "</div>";
      };

      const renderServiceItem = (service) => {
        return '<li class="service-item"><h3 class="service-name">' + service.label + '</h3><div class="service-rows">'
          + renderRow("Frontend", service.frontendURL, service.frontendHint || "has no frontend")
          + renderRow("API", service.apiURL, service.apiHint || "has no api")
          + renderRow("Docs", service.docsURL, service.docsHint || "has no docs")
          + "</div></li>";
      };

      const platformServiceList = document.getElementById("platform-service-list");
      platformServiceList.innerHTML = platformServices.map(renderServiceItem).join("");

      const serviceList = document.getElementById("service-list");
      serviceList.innerHTML = services.map(renderServiceItem).join("");

      const routeList = document.getElementById("route-list");
      routeList.innerHTML = routes.length === 0
        ? '<li class="service-item"><span class="row-empty">no routes registered</span></li>'
        : routes.map((route) => {
            const tags = Array.isArray(route.tags) && route.tags.length > 0 ? " [" + route.tags.join(",") + "]" : "";
            return '<li class="service-item"><span class="platform-label">' + route.host + tags + '</span><span class="row-empty">' + route.target + "</span></li>";
          }).join("");
    </script>
  </body>
</html>`;
}

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const homeRouter = createSimpleServiceRouter({
  serviceName,
  version: "0.0.1",
});

const openAPIHandler = createServiceOpenAPIHandler({
  router: homeRouter,
  title: "jonasland home API",
  version: "0.0.1",
});

const env = getEnv();
const registry = env.registryOrpcURL ? createRegistryClient({ url: env.registryOrpcURL }) : null;

const app = new Hono<ServiceAppEnv>();
const { injectWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

app.get("/api/observability", (c) => c.json({ otel: getOtelRuntimeConfig() }));

app.get("/api/home", async (c) => {
  const homeData = await (
    registry ? resolveHomeData(registry) : Promise.reject(new Error("registry unavailable"))
  ).catch((error) => {
    serviceLog.warn({
      event: "home.registry.resolve_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      platformLinks: platformLinks.map((link) => ({
        label: link.label,
        href: toInternalURL(link.host, link.path),
        ...(link.hint ? { hint: link.hint } : {}),
      })),
      platformServices: platformServices.map((service) => ({
        label: service.label,
        ...(service.frontendPath
          ? { frontendURL: toInternalURL(service.host, service.frontendPath) }
          : {}),
        ...(service.apiPath ? { apiURL: toInternalURL(service.host, service.apiPath) } : {}),
        ...(service.docsPath ? { docsURL: toInternalURL(service.host, service.docsPath) } : {}),
        ...(service.frontendHint ? { frontendHint: service.frontendHint } : {}),
        ...(service.apiHint ? { apiHint: service.apiHint } : {}),
        ...(service.docsHint ? { docsHint: service.docsHint } : {}),
      })),
      services: services.map((service) => ({
        label: service.label,
        ...(service.frontendPath
          ? { frontendURL: toInternalURL(service.host, service.frontendPath) }
          : {}),
        ...(service.apiPath ? { apiURL: toInternalURL(service.host, service.apiPath) } : {}),
        ...(service.docsPath ? { docsURL: toInternalURL(service.host, service.docsPath) } : {}),
        ...(service.frontendHint ? { frontendHint: service.frontendHint } : {}),
        ...(service.apiHint ? { apiHint: service.apiHint } : {}),
        ...(service.docsHint ? { docsHint: service.docsHint } : {}),
      })),
      routes: [],
    };
  });
  return c.html(buildHomeHtml(homeData));
});

applyOpenAPIRoute(app, openAPIHandler, serviceName);

export default app;
export { injectWebSocket };
