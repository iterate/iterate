import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const port = Number(process.env.PORT || "19000");
const externalProxy = process.env.ITERATE_EXTERNAL_EGRESS_PROXY || "";
const egressSeenHeader = "x-egress-proxy-seen";

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function filteredHeaders(headers, options = {}) {
  const stripHopByHop = options.stripHopByHop ?? true;
  const stripHost = options.stripHost ?? true;
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const lowerKey = key.toLowerCase();
    if (stripHost && lowerKey === "host") continue;
    if (stripHopByHop && hopByHop.has(lowerKey)) continue;
    next[key] = value;
  }
  return next;
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

function resolveTarget(req, protocolKind) {
  if (externalProxy) {
    const proxyTarget = normalizeProxyProtocol(
      new URL(req.url || "/", externalProxy),
      protocolKind,
    );
    return {
      mode: "external-proxy",
      url: proxyTarget.toString(),
    };
  }

  const directUrl = req.headers["x-target-url"];
  if (!directUrl || Array.isArray(directUrl)) {
    return null;
  }

  return { mode: "direct", url: directUrl };
}

function writeUpgradeResponse(socket, statusCode, statusMessage, headers) {
  socket.write(`HTTP/1.1 ${String(statusCode)} ${statusMessage}\r\n`);
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        socket.write(`${key}: ${item}\r\n`);
      }
      continue;
    }
    socket.write(`${key}: ${value}\r\n`);
  }
  socket.write("\r\n");
}

const server = createServer(async (req, res) => {
  if ((req.url || "") === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const target = resolveTarget(req, "http");
  if (!target) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_target_url" }));
    return;
  }

  const bodyParts = [];
  for await (const chunk of req) {
    bodyParts.push(chunk);
  }

  const init = {
    method: req.method,
    headers: filteredHeaders(req.headers),
    redirect: "manual",
  };
  init.headers[egressSeenHeader] = "1";
  init.headers["x-egress-mode"] = target.mode;

  if (bodyParts.length > 0) {
    init.body = Buffer.concat(bodyParts);
  }

  try {
    const upstream = await fetch(target.url, init);
    const responseHeaders = filteredHeaders(Object.fromEntries(upstream.headers.entries()));
    responseHeaders["x-egress-mode"] = target.mode;
    responseHeaders[egressSeenHeader] = "1";

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, responseHeaders);
    res.end(responseBody);
  } catch {
    res.writeHead(502, {
      "content-type": "application/json",
      "x-egress-mode": target.mode,
      [egressSeenHeader]: "1",
    });
    res.end(JSON.stringify({ error: "egress_forward_failed" }));
  }
});

server.on("upgrade", (req, socket, head) => {
  const target = resolveTarget(req, "ws");
  if (!target) {
    socket.write(
      'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\r\n{"error":"missing_target_url"}',
    );
    socket.destroy();
    return;
  }

  const targetUrl = new URL(target.url);
  const isSecure = targetUrl.protocol === "wss:" || targetUrl.protocol === "https:";
  const requestFn = isSecure ? httpsRequest : httpRequest;
  const upstreamHeaders = filteredHeaders(req.headers, { stripHopByHop: false, stripHost: true });
  upstreamHeaders[egressSeenHeader] = "1";
  upstreamHeaders["x-egress-mode"] = target.mode;

  const upstreamRequest = requestFn({
    protocol: isSecure ? "https:" : "http:",
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isSecure ? "443" : "80"),
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: "GET",
    headers: upstreamHeaders,
  });

  upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const responseHeaders = filteredHeaders(upstreamResponse.headers, {
      stripHopByHop: false,
      stripHost: true,
    });
    responseHeaders["x-egress-mode"] = target.mode;
    responseHeaders[egressSeenHeader] = "1";

    writeUpgradeResponse(
      socket,
      upstreamResponse.statusCode || 101,
      upstreamResponse.statusMessage || "Switching Protocols",
      responseHeaders,
    );

    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);

    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
  });

  upstreamRequest.on("response", (upstreamResponse) => {
    writeUpgradeResponse(
      socket,
      upstreamResponse.statusCode || 502,
      upstreamResponse.statusMessage || "Bad Gateway",
      {
        ...filteredHeaders(upstreamResponse.headers, { stripHopByHop: false, stripHost: true }),
        "x-egress-mode": target.mode,
        [egressSeenHeader]: "1",
      },
    );
    upstreamResponse.pipe(socket);
  });

  upstreamRequest.on("error", () => {
    socket.write(
      `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\nx-egress-mode: ${target.mode}\r\n${egressSeenHeader}: 1\r\n\r\n{"error":"egress_upgrade_failed"}`,
    );
    socket.destroy();
  });

  upstreamRequest.end();
});

server.listen(port, "0.0.0.0");
