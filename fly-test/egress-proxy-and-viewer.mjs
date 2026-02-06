#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const PROXY_PORT = Number(process.env.EGRESS_PROXY_PORT ?? "18080");
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function nowUtc() {
  return new Date().toISOString();
}

function appendLog(message) {
  const line = `${nowUtc()} ${message}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function getTail(path, maxLines) {
  if (!fs.existsSync(path)) return [];
  const data = fs.readFileSync(path, "utf8");
  const lines = data.split("\n").filter((line) => line.length > 0);
  return lines.slice(-maxLines);
}

function copyHeaders(sourceHeaders, overrideHost) {
  const out = {};
  for (const [key, value] of Object.entries(sourceHeaders)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  if (overrideHost) out.host = overrideHost;
  return out;
}

function handleProxyHttp(req, res) {
  const raw = req.url ?? "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const host = req.headers.host ?? "";
    try {
      parsed = new URL(`http://${host}${raw}`);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad target URL");
      appendLog(
        `HTTP_BAD_REQUEST client=${req.socket.remoteAddress} method=${req.method} url="${raw}"`,
      );
      return;
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("only http/https supported");
    appendLog(
      `HTTP_BAD_SCHEME client=${req.socket.remoteAddress} method=${req.method} url="${raw}"`,
    );
    return;
  }

  const lib = parsed.protocol === "https:" ? https : http;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  const path = `${parsed.pathname}${parsed.search}`;
  const headers = copyHeaders(req.headers, parsed.host);

  const upstreamReq = lib.request(
    {
      host: parsed.hostname,
      port,
      method: req.method,
      path,
      headers,
      timeout: 20_000,
    },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      let bytes = 0;
      upstreamRes.on("data", (chunk) => {
        bytes += chunk.length;
      });
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => {
        appendLog(
          `HTTP client=${req.socket.remoteAddress}:${req.socket.remotePort} method=${req.method} url="${parsed.href}" status=${upstreamRes.statusCode ?? 0} bytes=${bytes}`,
        );
      });
    },
  );

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("upstream timeout"));
  });
  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream error: ${error.message}`);
    } else {
      res.end();
    }
    appendLog(
      `HTTP_ERROR client=${req.socket.remoteAddress}:${req.socket.remotePort} method=${req.method} url="${parsed.href}" err="${error.message}"`,
    );
  });

  req.pipe(upstreamReq);
}

function handleConnect(req, clientSocket, head) {
  const target = req.url ?? "";
  const [host, portRaw] = target.split(":");
  const port = Number(portRaw || "443");
  if (!host || Number.isNaN(port)) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    appendLog(
      `CONNECT_BAD_TARGET client=${req.socket.remoteAddress}:${req.socket.remotePort} target="${target}"`,
    );
    return;
  }

  appendLog(
    `CONNECT_OPEN client=${req.socket.remoteAddress}:${req.socket.remotePort} target="${host}:${port}"`,
  );
  const upstreamSocket = net.connect(port, host);
  let upBytes = 0;
  let downBytes = 0;

  upstreamSocket.on("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) {
      upstreamSocket.write(head);
      upBytes += head.length;
    }
    clientSocket.on("data", (chunk) => {
      upBytes += chunk.length;
    });
    upstreamSocket.on("data", (chunk) => {
      downBytes += chunk.length;
    });
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  const close = (reason) => {
    upstreamSocket.destroy();
    clientSocket.destroy();
    appendLog(
      `CONNECT_CLOSE client=${req.socket.remoteAddress}:${req.socket.remotePort} target="${host}:${port}" reason="${reason}" up_bytes=${upBytes} down_bytes=${downBytes}`,
    );
  };

  upstreamSocket.on("error", (error) => {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    close(`upstream_error:${error.message}`);
  });
  clientSocket.on("error", (error) => {
    close(`client_error:${error.message}`);
  });
  upstreamSocket.on("end", () => close("upstream_end"));
  clientSocket.on("end", () => close("client_end"));
}

function startProxyServer() {
  const server = http.createServer(handleProxyHttp);
  server.on("connect", handleConnect);
  server.listen(PROXY_PORT, "::", () => {
    appendLog(`PROXY_LISTEN port=${PROXY_PORT}`);
  });
  return server;
}

function viewerHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Egress Proxy Log</title>
  <style>
    body { margin: 0; background: #0b1020; color: #dde4ff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    header { position: sticky; top: 0; background: #0b1020; border-bottom: 1px solid #24304f; padding: 10px 14px; }
    pre { margin: 0; padding: 14px; white-space: pre-wrap; word-wrap: break-word; }
    .muted { color: #8aa0cf; }
  </style>
</head>
<body>
  <header>
    <div>Egress Proxy Live Log</div>
    <div class="muted">${LOG_PATH}</div>
  </header>
  <pre id="log"></pre>
  <script>
    const el = document.getElementById("log");
    let lastText = "";
    async function pollTail() {
      try {
        const res = await fetch("/tail?lines=400&ts=" + Date.now(), { cache: "no-store" });
        if (!res.ok) throw new Error("status=" + res.status);
        const text = await res.text();
        if (text !== lastText) {
          lastText = text;
          el.textContent = text;
          window.scrollTo(0, document.body.scrollHeight);
        }
      } catch (error) {
        const msg = String(error);
        if (!el.textContent.includes("[viewer] poll error")) {
          el.textContent += "\\n[viewer] poll error: " + msg + "\\n";
        }
      }
    }
    pollTail();
    setInterval(pollTail, 1000);
  </script>
</body>
</html>`;
}

function startViewerServer() {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400).end("bad request");
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    if (req.url === "/") {
      const body = viewerHtml();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.url.startsWith("/tail")) {
      const parsed = new URL(req.url, "http://local");
      const requestedLines = Number(parsed.searchParams.get("lines") ?? "300");
      const maxLines = Number.isNaN(requestedLines)
        ? 300
        : Math.max(1, Math.min(requestedLines, 1000));
      const text = `${getTail(LOG_PATH, maxLines).join("\n")}\n`;
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
      return;
    }
    if (req.url.startsWith("/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const initial = getTail(LOG_PATH, 250);
      for (const line of initial) {
        res.write(`data: ${line}\n\n`);
      }
      let lastSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
      const timer = setInterval(() => {
        if (!fs.existsSync(LOG_PATH)) return;
        const stats = fs.statSync(LOG_PATH);
        if (stats.size < lastSize) lastSize = 0;
        if (stats.size > lastSize) {
          const fd = fs.openSync(LOG_PATH, "r");
          const chunk = Buffer.alloc(stats.size - lastSize);
          fs.readSync(fd, chunk, 0, chunk.length, lastSize);
          fs.closeSync(fd);
          lastSize = stats.size;
          const lines = chunk
            .toString("utf8")
            .split("\n")
            .filter((line) => line.length > 0);
          for (const line of lines) {
            res.write(`data: ${line}\n\n`);
          }
        }
        res.write(": hb\n\n");
      }, 1200);
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.listen(VIEWER_PORT, "::", () => {
    appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
  });
  return server;
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} proxy_port=${PROXY_PORT} viewer_port=${VIEWER_PORT}`);
startProxyServer();
startViewerServer();
