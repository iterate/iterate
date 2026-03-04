import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import httpProxy from "http-proxy";
import {
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";

const serviceName = "jonasland-egress-service";

const iterateTargetUrlHeader = "x-iterate-target-url";
const iterateEgressModeHeader = "x-iterate-egress-mode";
const iterateEgressSeenHeader = "x-iterate-egress-proxy-seen";

const legacyTargetUrlHeader = "x-target-url";
const legacyEgressModeHeader = "x-egress-mode";

const forwardingContextHeaderPrefixes = ["x-forwarded-"] as const;

type ProtocolKind = "http" | "ws";
type ForwardedProto = "http" | "https" | "ws" | "wss";

type ForwardingContext = {
  host: string | null;
  proto: ForwardedProto;
  forValue?: string;
};

type EgressMode = "external-proxy" | "direct" | "transparent";

type EgressEnv = {
  proxyHost: string;
  proxyPort: number;
  adminHost: string;
  adminPort: number;
  externalProxy: string;
};

type ProxyRequestResolution = {
  mode: EgressMode;
  targetOrigin: string;
  pathWithQuery: string;
  forwardedHost: string;
  forwardedProto: ForwardedProto;
  forwardedFor?: string;
};

function parsePort(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key}: ${value}`);
  }
  return parsed;
}

function getEnv(): EgressEnv {
  const rawProxyHost = process.env.EGRESS_PROXY_HOST?.trim();
  const rawAdminHost = process.env.EGRESS_ADMIN_HOST?.trim();

  return {
    proxyHost: rawProxyHost && rawProxyHost.length > 0 ? rawProxyHost : "0.0.0.0",
    proxyPort: parsePort(
      process.env.EGRESS_PROXY_PORT ?? process.env.PORT ?? "19000",
      "EGRESS_PROXY_PORT",
    ),
    adminHost: rawAdminHost && rawAdminHost.length > 0 ? rawAdminHost : "127.0.0.1",
    adminPort: parsePort(process.env.EGRESS_ADMIN_PORT ?? "19001", "EGRESS_ADMIN_PORT"),
    externalProxy: process.env.ITERATE_EXTERNAL_EGRESS_PROXY ?? "",
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function preferredHeader(req: IncomingMessage, preferredName: string, legacyName: string): string {
  return firstHeaderValue(req.headers[preferredName]) || firstHeaderValue(req.headers[legacyName]);
}

function currentEgressMode(req: IncomingMessage): string {
  return String(preferredHeader(req, iterateEgressModeHeader, legacyEgressModeHeader) || "unknown");
}

function normalizeClientIp(rawAddress: string | undefined): string | undefined {
  if (!rawAddress) return undefined;
  const trimmed = rawAddress.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

function normalizeForwardedProto(
  proto: string | undefined,
  protocolKind: ProtocolKind,
): ForwardedProto {
  const normalized = proto?.trim().toLowerCase();
  if (protocolKind === "ws") {
    if (normalized === "https" || normalized === "wss") return "wss";
    return "ws";
  }
  if (normalized === "https" || normalized === "wss") return "https";
  return "http";
}

function resolveForwardingContext(
  req: IncomingMessage,
  protocolKind: ProtocolKind,
): ForwardingContext {
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]).trim();
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]).trim();
  const forwardedFor = firstHeaderValue(req.headers["x-forwarded-for"]).split(",")[0]?.trim();
  const fallbackHost = firstHeaderValue(req.headers.host).trim();

  return {
    host: forwardedHost && forwardedHost.length > 0 ? forwardedHost : fallbackHost || null,
    proto: normalizeForwardedProto(forwardedProto || undefined, protocolKind),
    forValue:
      forwardedFor && forwardedFor.length > 0
        ? forwardedFor
        : normalizeClientIp(req.socket.remoteAddress),
  };
}

function stripForwardingContextHeaders(headers: IncomingHttpHeaders): void {
  for (const headerName of Object.keys(headers)) {
    const lowered = headerName.toLowerCase();
    if (lowered === "forwarded") {
      delete headers[headerName];
      continue;
    }
    if (forwardingContextHeaderPrefixes.some((prefix) => lowered.startsWith(prefix))) {
      delete headers[headerName];
      continue;
    }
    if (lowered.startsWith("x-") && lowered.includes("-original-")) {
      delete headers[headerName];
    }
  }
}

function normalizeProxyProtocol(url: URL, protocolKind: ProtocolKind): URL {
  if (protocolKind === "ws") {
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url;
  }

  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url;
}

function buildTransparentTarget(
  req: IncomingMessage,
  protocolKind: ProtocolKind,
  forwardingContext: ForwardingContext,
): string | null {
  const rawUrl = req.url || "/";
  if (/^https?:\/\//i.test(rawUrl) || /^wss?:\/\//i.test(rawUrl)) {
    return normalizeProxyProtocol(new URL(rawUrl), protocolKind).toString();
  }

  const host = forwardingContext.host;
  if (!host) return null;

  const scheme = forwardingContext.proto;
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `${scheme}://${host}${path}`;
}

function resolveTarget(
  req: IncomingMessage,
  protocolKind: ProtocolKind,
  env: EgressEnv,
  forwardingContext: ForwardingContext,
): { mode: EgressMode; url: string } | null {
  if (env.externalProxy) {
    return {
      mode: "external-proxy",
      url: normalizeProxyProtocol(
        new URL(req.url || "/", env.externalProxy),
        protocolKind,
      ).toString(),
    };
  }

  const directUrl =
    preferredHeader(req, iterateTargetUrlHeader, legacyTargetUrlHeader) || undefined;
  if (directUrl) {
    return { mode: "direct", url: directUrl };
  }

  const transparentUrl = buildTransparentTarget(req, protocolKind, forwardingContext);
  if (!transparentUrl) return null;
  return { mode: "transparent", url: transparentUrl };
}

function resolveProxyRequest(
  req: IncomingMessage,
  protocolKind: ProtocolKind,
  env: EgressEnv,
): ProxyRequestResolution | null {
  const forwardingContext = resolveForwardingContext(req, protocolKind);
  const target = resolveTarget(req, protocolKind, env, forwardingContext);
  if (!target) return null;

  const targetUrl = new URL(target.url);
  const forwardedHost = forwardingContext.host ?? targetUrl.host;

  return {
    mode: target.mode,
    targetOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
    pathWithQuery: `${targetUrl.pathname}${targetUrl.search}`,
    forwardedHost,
    forwardedProto: forwardingContext.proto,
    forwardedFor: forwardingContext.forValue,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startEgressService(options?: {
  proxyHost?: string;
  proxyPort?: number;
  adminHost?: string;
  adminPort?: number;
}): Promise<{ close: () => Promise<void> }> {
  const env = getEnv();
  const proxyHost = options?.proxyHost ?? env.proxyHost;
  const proxyPort = options?.proxyPort ?? env.proxyPort;
  const adminHost = options?.adminHost ?? env.adminHost;
  const adminPort = options?.adminPort ?? env.adminPort;

  initializeServiceOtel(serviceName);
  initializeServiceEvlog(serviceName);

  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: false,
    secure: false,
  });

  const pendingHttpRequests = new WeakMap<
    IncomingMessage,
    {
      requestLog: ServiceRequestLogger;
      startedAt: number;
    }
  >();

  proxy.on("proxyRes", (proxyRes, req) => {
    const request = req as IncomingMessage;
    proxyRes.headers[iterateEgressSeenHeader] = "1";
    proxyRes.headers[iterateEgressModeHeader] = currentEgressMode(request);

    const pending = pendingHttpRequests.get(request);
    if (!pending) return;

    pending.requestLog.emit({
      status: proxyRes.statusCode ?? 200,
      durationMs: Date.now() - pending.startedAt,
    });
    pendingHttpRequests.delete(request);
  });

  proxy.on("error", (error, req, res) => {
    const request = req as IncomingMessage;
    const pending = pendingHttpRequests.get(request);

    if (res && typeof (res as ServerResponse).writeHead === "function") {
      const response = res as ServerResponse;
      if (!response.headersSent) {
        response.writeHead(502, {
          "content-type": "application/json",
          [iterateEgressSeenHeader]: "1",
          [iterateEgressModeHeader]: currentEgressMode(request),
        });
        response.end(
          JSON.stringify({
            error: "egress_forward_failed",
            message: error instanceof Error ? error.message : "proxy_error",
          }),
        );
      }
    }

    if (pending) {
      pending.requestLog.error(toError(error));
      pending.requestLog.emit({
        status: 502,
        durationMs: Date.now() - pending.startedAt,
      });
      pendingHttpRequests.delete(request);
      return;
    }

    serviceLog.error({
      event: "egress.proxy.error",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const proxyServer = createServer((req, res) => {
    const requestId = randomUUID();
    const requestLog = createServiceRequestLogger({
      requestId,
      method: req.method,
      path: req.url,
    });
    const startedAt = Date.now();

    if ((req.url || "") === "/healthz") {
      res.writeHead(200, {
        "content-type": "text/plain",
        [iterateEgressSeenHeader]: "1",
      });
      res.end("ok");
      requestLog.emit({ status: 200, durationMs: Date.now() - startedAt });
      return;
    }

    const resolved = resolveProxyRequest(req, "http", env);
    if (!resolved) {
      writeJson(res, 400, { error: "missing_target_url" });
      requestLog.emit({ status: 400, durationMs: Date.now() - startedAt });
      return;
    }

    req.url = resolved.pathWithQuery;
    req.headers.host = new URL(resolved.targetOrigin).host;
    stripForwardingContextHeaders(req.headers);
    req.headers["x-forwarded-host"] = resolved.forwardedHost;
    req.headers["x-forwarded-proto"] = resolved.forwardedProto;
    if (resolved.forwardedFor) {
      req.headers["x-forwarded-for"] = resolved.forwardedFor;
    }
    req.headers[iterateEgressSeenHeader] = "1";
    req.headers[iterateEgressModeHeader] = resolved.mode;

    pendingHttpRequests.set(req, { requestLog, startedAt });

    proxy.web(req, res, {
      target: resolved.targetOrigin,
      changeOrigin: true,
    });
  });

  proxyServer.on("upgrade", (req, socket, head) => {
    const resolved = resolveProxyRequest(req, "ws", env);
    if (!resolved) {
      socket.write(
        'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\r\n{"error":"missing_target_url"}',
      );
      socket.destroy();
      return;
    }

    req.url = resolved.pathWithQuery;
    req.headers.host = new URL(resolved.targetOrigin).host;
    stripForwardingContextHeaders(req.headers);
    req.headers["x-forwarded-host"] = resolved.forwardedHost;
    req.headers["x-forwarded-proto"] = resolved.forwardedProto;
    if (resolved.forwardedFor) {
      req.headers["x-forwarded-for"] = resolved.forwardedFor;
    }
    req.headers[iterateEgressSeenHeader] = "1";
    req.headers[iterateEgressModeHeader] = resolved.mode;

    proxy.ws(req, socket, head, {
      target: resolved.targetOrigin,
      changeOrigin: true,
    });
  });

  const adminServer = createServer((req, res) => {
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

      if (req.method === "GET" && pathname === "/api/runtime") {
        status = 200;
        writeJson(res, status, {
          service: serviceName,
          proxy: {
            host: proxyHost,
            port: proxyPort,
          },
          admin: {
            host: adminHost,
            port: adminPort,
          },
          externalProxyConfigured: env.externalProxy.length > 0,
          otel: getOtelRuntimeConfig(),
        });
        return;
      }

      status = 404;
      writeJson(res, status, { error: "not_found" });
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
    proxyServer.listen(proxyPort, proxyHost, () => resolve());
  });

  await new Promise<void>((resolve) => {
    adminServer.listen(adminPort, adminHost, () => resolve());
  });

  serviceLog.info({
    event: "service.started",
    service: serviceName,
    proxy_host: proxyHost,
    proxy_port: proxyPort,
    admin_host: adminHost,
    admin_port: adminPort,
    proxy_health_path: "/healthz",
    admin_health_path: "/healthz",
    runtime_path: "/api/runtime",
    otel: getOtelRuntimeConfig(),
  });

  return {
    close: async () => {
      proxy.close();
      await Promise.all([closeServer(proxyServer), closeServer(adminServer)]);
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startEgressService()
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
