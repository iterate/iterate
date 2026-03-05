import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import httpProxy from "http-proxy";
import { parseProxyTargetHost, type ParsedProxyTargetHost } from "./proxy-target-host.ts";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8080;
const TARGET_HOST_HEADER = "x-iterate-proxy-target-host";
const PROXY_VIA_HEADER = "x-iterate-proxy-via";

type ProxyErrorCode = "missing_proxy_target_host" | "invalid_proxy_target_host" | "proxy_error";

type TargetResolution =
  | { ok: true; target: ParsedProxyTargetHost }
  | { ok: false; error: Exclude<ProxyErrorCode, "proxy_error"> };

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function getPathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function writeJsonError(res: ServerResponse, status: number, error: ProxyErrorCode): void {
  const payload = JSON.stringify({ error });
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

function writeUpgradeError(socket: Duplex, status: number, error: ProxyErrorCode): void {
  const payload = JSON.stringify({ error });
  socket.write(
    `HTTP/1.1 ${status} Bad Request\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      payload,
  );
  socket.destroy();
}

function resolveTarget(req: IncomingMessage): TargetResolution {
  const rawTargetHost = getHeaderValue(req.headers[TARGET_HOST_HEADER]);
  if (!rawTargetHost || rawTargetHost.trim().length === 0) {
    return { ok: false, error: "missing_proxy_target_host" };
  }

  const parsed = parseProxyTargetHost(rawTargetHost);
  if (!parsed) {
    return { ok: false, error: "invalid_proxy_target_host" };
  }

  return { ok: true, target: parsed };
}

function rewriteHeadersForProxy(req: IncomingMessage, target: ParsedProxyTargetHost): void {
  const inboundHost = getHeaderValue(req.headers.host) ?? "";
  req.headers.host = target.upstreamHostHeader;
  req.headers[PROXY_VIA_HEADER] = inboundHost;
  delete req.headers[TARGET_HOST_HEADER];
}

export function createProjectIngressProxyServer(): Server {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, changeOrigin: false });

  const server = createServer((req, res) => {
    if (getPathname(req.url) === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("OK");
      return;
    }

    const resolution = resolveTarget(req);
    if (!resolution.ok) {
      writeJsonError(res, 400, resolution.error);
      return;
    }

    rewriteHeadersForProxy(req, resolution.target);
    proxy.web(req, res, { target: resolution.target.upstreamOrigin }, () => {
      if (!res.headersSent) {
        writeJsonError(res, 502, "proxy_error");
      } else {
        res.end();
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const resolution = resolveTarget(req);
    if (!resolution.ok) {
      writeUpgradeError(socket, 400, resolution.error);
      return;
    }

    rewriteHeadersForProxy(req, resolution.target);
    proxy.ws(req, socket, head, { target: resolution.target.upstreamOrigin }, () => {
      socket.destroy();
    });
  });

  return server;
}

export async function startProjectIngressProxyServer(params?: {
  host?: string;
  port?: number;
}): Promise<Server> {
  const host = params?.host ?? DEFAULT_HOST;
  const port = params?.port ?? DEFAULT_PORT;
  const server = createProjectIngressProxyServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  return server;
}

const shouldStartServer =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (shouldStartServer) {
  void startProjectIngressProxyServer().catch((error) => {
    console.error("project-ingress-proxy failed to start", error);
    process.exit(1);
  });
}
