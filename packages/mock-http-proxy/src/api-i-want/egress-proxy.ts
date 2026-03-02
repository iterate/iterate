import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import httpProxy from "http-proxy";
import { URL } from "node:url";

const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  secure: true,
  xfwd: false,
});

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getOriginalUrl(req: IncomingMessage): string | undefined {
  return firstHeaderValue(req.headers["x-original-url"]);
}

function unrewriteHeaders(req: IncomingMessage): void {
  delete req.headers["x-original-url"];
  delete req.headers["x-original-host"];
  delete req.headers["x-original-scheme"];
}

function badRequest(res: ServerResponse): void {
  res.writeHead(400, { "content-type": "text/plain" });
  res.end("Missing X-Original-Url header");
}

const server = createServer((req, res) => {
  const originalUrl = getOriginalUrl(req);
  if (!originalUrl) {
    badRequest(res);
    return;
  }

  const targetUrl = new URL(originalUrl);
  const target = `${targetUrl.protocol}//${targetUrl.host}`;
  console.log(`[EGRESS] ${req.method ?? "GET"} ${originalUrl} -> ${target}`);

  unrewriteHeaders(req);

  proxy.web(req, res, { target }, (error) => {
    console.error("[EGRESS ERROR]", error.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  const originalUrl = getOriginalUrl(req);
  if (!originalUrl) {
    socket.destroy();
    return;
  }

  const targetUrl = new URL(originalUrl);
  const target = `${targetUrl.protocol}//${targetUrl.host}`;
  console.log(`[EGRESS WS] Upgrade ${originalUrl} -> ${target}`);

  unrewriteHeaders(req);
  proxy.ws(req, socket, head, { target });
});

proxy.on("error", (error) => {
  console.error("[EGRESS PROXY ERROR]", error.message);
});

server.listen(8082, () => {
  console.log("Egress proxy listening on http://127.0.0.1:8082");
});
