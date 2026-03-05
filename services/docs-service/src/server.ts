import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import {
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  registerServiceWithRegistry,
  serviceLog,
} from "@iterate-com/shared/jonasland";
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

function writeJsonResponse(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getProtocol(req: IncomingMessage): "http" | "https" {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();

  if (forwardedProto === "http" || forwardedProto === "https") {
    return forwardedProto;
  }

  if ("encrypted" in req.socket && req.socket.encrypted) {
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

function getIngressPort(req: IncomingMessage, protocol: "http" | "https"): string | undefined {
  const hostHeader = firstHeaderValue(req.headers.host)?.trim();
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

const REGISTRY_ORPC_URL = "http://registry.iterate.localhost/orpc";

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

export async function startDocsService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const env = getEnv();
  const host = options?.host ?? env.DOCS_SERVICE_HOST;
  const port = options?.port ?? env.DOCS_SERVICE_PORT;

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestLog = createServiceRequestLogger({
      requestId,
      method: req.method,
      path: req.url,
    });
    const startedAt = Date.now();
    let status = 500;

    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const pathname = requestUrl.pathname;

      if (req.method === "GET" && pathname === "/__iterate/health") {
        status = 200;
        writeJsonResponse(res, 200, { ok: true, service: serviceName });
        return;
      }

      if (req.method === "POST" && pathname === "/__iterate/sql") {
        status = 501;
        writeJsonResponse(res, 501, { error: "sql_not_supported" });
        return;
      }

      if (req.method === "GET" && pathname === "/__iterate/debug") {
        status = 200;
        writeJsonResponse(res, 200, {
          pid: process.pid,
          ppid: process.ppid,
          uptimeSec: process.uptime(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          cwd: process.cwd(),
          execPath: process.execPath,
          argv: process.argv,
          otel: getOtelRuntimeConfig(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/observability") {
        status = 200;
        writeJsonResponse(res, 200, {
          otel: getOtelRuntimeConfig(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/openapi-sources") {
        try {
          const protocol = getProtocol(req);
          const ingressPort = getIngressPort(req, protocol);
          const sources = await listOpenApiSources({
            protocol,
            ingressPort,
          });
          status = 200;
          writeJsonResponse(res, 200, { sources, total: sources.length });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          serviceLog.warn({
            event: "docs.openapi_sources.fetch_failed",
            service: serviceName,
            request_id: requestId,
            message,
          });
          status = 503;
          writeJsonResponse(res, 503, { error: "services_registry_unavailable", message });
        }
        return;
      }

      if (pathname.startsWith("/api/")) {
        status = 404;
        writeJsonResponse(res, 404, { error: "not_found" });
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const protocol = getProtocol(req);
        const ingressPort = getIngressPort(req, protocol);
        const sources = await listOpenApiSources({
          protocol,
          ingressPort,
        });
        const html = renderScalarDocsHtml(sources);
        status = 200;
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(html);
        return;
      }

      status = 404;
      writeJsonResponse(res, 404, { error: "not_found" });
    } catch (error) {
      requestLog.error(error instanceof Error ? error : new Error(String(error)));
      status = 500;
      writeJsonResponse(res, 500, { error: "internal_error" });
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
    docs_path: "/",
    health_path: "/__iterate/health",
    sql_path: "/__iterate/sql",
    debug_path: "/__iterate/debug",
    openapi_sources_path: "/api/openapi-sources",
    otel: getOtelRuntimeConfig(),
  });

  void registerServiceWithRegistry({
    manifest: { slug: "docs-service", port, orpcContract: {} as any },
    port,
    metadata: { title: "Docs Service" },
    tags: ["docs"],
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
  startDocsService().catch(() => {
    process.exit(1);
  });
}
