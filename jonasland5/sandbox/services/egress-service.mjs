import { createServer } from "node:http";
import httpProxy from "http-proxy";

const port = Number(process.env.PORT || "19000");
const externalProxy = process.env.ITERATE_EXTERNAL_EGRESS_PROXY || "";
const iterateOriginalHostHeader = "x-iterate-original-host";
const iterateOriginalProtoHeader = "x-iterate-original-proto";
const iterateTargetUrlHeader = "x-iterate-target-url";
const iterateEgressModeHeader = "x-iterate-egress-mode";
const iterateEgressSeenHeader = "x-iterate-egress-proxy-seen";

// Backward-compatible read aliases while migrating callers.
const legacyOriginalHostHeader = "x-original-host";
const legacyOriginalProtoHeader = "x-original-proto";
const legacyTargetUrlHeader = "x-target-url";
const legacyEgressModeHeader = "x-egress-mode";

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  secure: false,
});

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function preferredHeader(req, preferredName, legacyName) {
  return firstHeaderValue(req.headers[preferredName]) || firstHeaderValue(req.headers[legacyName]);
}

function currentEgressMode(req) {
  return String(preferredHeader(req, iterateEgressModeHeader, legacyEgressModeHeader) || "unknown");
}

function normalizeProxyProtocol(url, protocolKind) {
  if (protocolKind === "ws") {
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url;
  }

  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url;
}

function buildTransparentTarget(req, protocolKind) {
  const rawUrl = req.url || "/";
  if (/^https?:\/\//i.test(rawUrl) || /^wss?:\/\//i.test(rawUrl)) {
    return normalizeProxyProtocol(new URL(rawUrl), protocolKind).toString();
  }

  const host =
    preferredHeader(req, iterateOriginalHostHeader, legacyOriginalHostHeader) ||
    firstHeaderValue(req.headers.host);
  if (!host) return null;

  const proto = String(
    preferredHeader(req, iterateOriginalProtoHeader, legacyOriginalProtoHeader),
  ).toLowerCase();
  let scheme = "http";
  if (protocolKind === "ws") {
    scheme = proto === "https" || proto === "wss" ? "wss" : "ws";
  } else {
    scheme = proto === "https" || proto === "wss" ? "https" : "http";
  }

  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `${scheme}://${host}${path}`;
}

function resolveTarget(req, protocolKind) {
  if (externalProxy) {
    return {
      mode: "external-proxy",
      url: normalizeProxyProtocol(new URL(req.url || "/", externalProxy), protocolKind).toString(),
    };
  }

  const directUrl =
    preferredHeader(req, iterateTargetUrlHeader, legacyTargetUrlHeader) || undefined;
  if (directUrl) {
    return { mode: "direct", url: directUrl };
  }

  const transparentUrl = buildTransparentTarget(req, protocolKind);
  if (!transparentUrl) return null;
  return { mode: "transparent", url: transparentUrl };
}

function resolveProxyRequest(req, protocolKind) {
  const target = resolveTarget(req, protocolKind);
  if (!target) return null;

  const targetUrl = new URL(target.url);
  return {
    mode: target.mode,
    targetOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
    pathWithQuery: `${targetUrl.pathname}${targetUrl.search}`,
  };
}

proxy.on("proxyRes", (proxyRes, req) => {
  proxyRes.headers[iterateEgressSeenHeader] = "1";
  proxyRes.headers[iterateEgressModeHeader] = currentEgressMode(req);
});

proxy.on("error", (error, req, res) => {
  if (!res || typeof res.writeHead !== "function" || res.headersSent) return;
  res.writeHead(502, {
    "content-type": "application/json",
    [iterateEgressSeenHeader]: "1",
    [iterateEgressModeHeader]: currentEgressMode(req),
  });
  res.end(
    JSON.stringify({
      error: "egress_forward_failed",
      message: error instanceof Error ? error.message : "proxy_error",
    }),
  );
});

const server = createServer((req, res) => {
  if ((req.url || "") === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const resolved = resolveProxyRequest(req, "http");
  if (!resolved) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_target_url" }));
    return;
  }

  req.url = resolved.pathWithQuery;
  req.headers.host = new URL(resolved.targetOrigin).host;
  req.headers[iterateEgressSeenHeader] = "1";
  req.headers[iterateEgressModeHeader] = resolved.mode;

  proxy.web(req, res, {
    target: resolved.targetOrigin,
    changeOrigin: true,
  });
});

server.on("upgrade", (req, socket, head) => {
  const resolved = resolveProxyRequest(req, "ws");
  if (!resolved) {
    socket.write(
      'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\r\n{"error":"missing_target_url"}',
    );
    socket.destroy();
    return;
  }

  req.url = resolved.pathWithQuery;
  req.headers.host = new URL(resolved.targetOrigin).host;
  req.headers[iterateEgressSeenHeader] = "1";
  req.headers[iterateEgressModeHeader] = resolved.mode;

  proxy.ws(req, socket, head, {
    target: resolved.targetOrigin,
    changeOrigin: true,
  });
});

server.listen(port, "0.0.0.0");
