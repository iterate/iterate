import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceOpenAPIHandler,
  createSimpleServiceRouter,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  registerServiceWithRegistry,
  serviceLog,
  type ServiceAppEnv,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { z } from "zod/v4";

interface OpenApiSource {
  id: string;
  title: string;
  specUrl: string;
}

interface RegistryRouteRecord {
  host: string;
  target: string;
  metadata: Record<string, string>;
  tags: string[];
  updatedAt: string;
}

const serviceName = "jonasland-docs-service";
const serviceVersion = "0.0.1";
const scalarScriptUrl = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";

const nonEmptyStringWithTrimDefault = (defaultValue: string) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().min(1).optional())
    .default(defaultValue);

const DocsServiceEnv = z.object({
  DOCS_SERVICE_HOST: nonEmptyStringWithTrimDefault("0.0.0.0"),
  DOCS_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19050),
});

type DocsServiceEnv = z.infer<typeof DocsServiceEnv>;

let envCache: DocsServiceEnv | null = null;

function getEnv() {
  envCache ??= DocsServiceEnv.parse(process.env);
  return envCache;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getProtocol(
  headers: Record<string, string | string[] | undefined>,
  encrypted?: unknown,
): "http" | "https" {
  const forwardedProto = firstHeaderValue(headers["x-forwarded-proto"])
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();

  if (forwardedProto === "http" || forwardedProto === "https") {
    return forwardedProto;
  }

  if (encrypted === true) {
    return "https";
  }

  return "http";
}

function normalizeOpenApiPath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getIngressPort(
  headers: Record<string, string | string[] | undefined>,
  protocol: "http" | "https",
): string | undefined {
  const hostHeader = firstHeaderValue(headers.host)?.trim();
  if (!hostHeader) return undefined;
  const [, maybePort] = hostHeader.split(":");
  if (!maybePort) return undefined;
  if (protocol === "http" && maybePort === "80") return undefined;
  if (protocol === "https" && maybePort === "443") return undefined;
  return maybePort;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderScalarDocsHtml(sources: OpenApiSource[]): string {
  const scalarSources = sources.map((source, index) => ({
    title: source.title,
    url: source.specUrl,
    default: index === 0,
  }));

  const scalarConfig = {
    title: "jonasland API Docs",
    layout: "modern",
    defaultOpenAllTags: true,
    operationTitleSource: "summary",
    operationsSorter: "method",
    defaultHttpClient: {
      targetKey: "shell",
      clientKey: "curl",
    },
    documentDownloadType: "direct",
    telemetry: false,
    sources: scalarSources,
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jonasland API Docs</title>
  </head>
  <body>
    <div id="app" data-config="${escapeHtml(JSON.stringify(scalarConfig))}"></div>
    <script src="${escapeHtml(scalarScriptUrl)}"></script>
    <script>
      const config = JSON.parse(document.getElementById("app").dataset.config)
      const tagName = (tag) =>
        typeof tag === "string"
          ? tag
          : tag && typeof tag.name === "string"
            ? tag.name
            : ""
      config.tagsSorter = (a, b) => {
        const aName = tagName(a).toLowerCase()
        const bName = tagName(b).toLowerCase()
        const aIsService = aName === "service"
        const bIsService = bName === "service"
        if (aIsService && !bIsService) return 1
        if (!aIsService && bIsService) return -1
        return aName.localeCompare(bName)
      }
      Scalar.createApiReference("#app", config)
    </script>
  </body>
</html>`;
}

const REGISTRY_ORPC_URL = "http://registry.iterate.localhost/api";

async function listOpenApiSources(params: {
  protocol: "http" | "https";
  ingressPort?: string;
}): Promise<OpenApiSource[]> {
  const servicesClient = createRegistryClient({ url: REGISTRY_ORPC_URL });
  const routes = await servicesClient.routes.list({});

  const docsRoutes = routes.routes
    .filter((route) => route.tags.some((tag) => tag.toLowerCase() === "openapi"))
    .map((route) => route as RegistryRouteRecord)
    .map((route) => {
      const openApiPath = normalizeOpenApiPath(route.metadata.openapiPath);
      if (openApiPath.length === 0) {
        return null;
      }

      const title = route.metadata.title?.trim() || route.host;
      const specUrl =
        openApiPath.startsWith("http://") || openApiPath.startsWith("https://")
          ? openApiPath
          : `${params.protocol}://${route.host}${params.ingressPort ? `:${params.ingressPort}` : ""}${openApiPath}`;

      return {
        id: route.host,
        title,
        specUrl,
      } satisfies OpenApiSource;
    })
    .filter((source): source is OpenApiSource => source !== null)
    .sort((a, b) => a.title.localeCompare(b.title));

  return docsRoutes;
}

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const docsRouter = createSimpleServiceRouter({
  serviceName,
  version: serviceVersion,
});

const openAPIHandler = createServiceOpenAPIHandler({
  router: docsRouter,
  title: "jonasland docs service",
  version: serviceVersion,
});

const app = new Hono<ServiceAppEnv>();
applyServiceMiddleware(app);

app.get("/api/openapi-sources", async (c) => {
  try {
    const incoming = c.env.incoming;
    const headers = incoming.headers as Record<string, string | string[] | undefined>;
    const encrypted = "encrypted" in incoming.socket && incoming.socket.encrypted;
    const protocol = getProtocol(headers, encrypted);
    const ingressPort = getIngressPort(headers, protocol);
    const sources = await listOpenApiSources({
      protocol,
      ingressPort,
    });
    return c.json({ sources, total: sources.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog.warn({
      event: "docs.openapi_sources.fetch_failed",
      service: serviceName,
      request_id: c.get("requestId"),
      message,
    });
    return c.json({ error: "services_registry_unavailable", message }, 503);
  }
});

app.get("/api/observability", async (c) => c.json({ otel: getOtelRuntimeConfig() }));

applyOpenAPIRoute(app, openAPIHandler, serviceName);

app.on(["GET", "HEAD"], "/*", async (c) => {
  const incoming = c.env.incoming;
  const headers = incoming.headers as Record<string, string | string[] | undefined>;
  const encrypted = "encrypted" in incoming.socket && incoming.socket.encrypted;
  const protocol = getProtocol(headers, encrypted);
  const ingressPort = getIngressPort(headers, protocol);
  const sources = await listOpenApiSources({
    protocol,
    ingressPort,
  });
  const html = renderScalarDocsHtml(sources);
  return c.html(html, 200, {
    "cache-control": "no-cache",
  });
});

export async function startDocsService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const env = getEnv();
  const host = options?.host ?? env.DOCS_SERVICE_HOST;
  const port = options?.port ?? env.DOCS_SERVICE_PORT;

  const server = createAdaptorServer({ fetch: app.fetch });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort = address && typeof address === "object" ? (address as AddressInfo).port : port;

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host,
    port: boundPort,
    docs_path: "/",
    openapi_sources_path: "/api/openapi-sources",
    otel: getOtelRuntimeConfig(),
  });

  void registerServiceWithRegistry({
    manifest: { slug: "docs", port: boundPort, orpcContract: {} as never },
    port: boundPort,
    metadata: { title: "Docs Service" },
    tags: ["docs"],
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startDocsService().catch(() => {
    process.exit(1);
  });
}
