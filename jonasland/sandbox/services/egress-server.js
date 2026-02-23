import { createServer } from "node:http";
import { URL } from "node:url";

const port = Number(process.env.ITERATE_EGRESS_PORT || "19000");
const externalProxy = process.env.ITERATE_EXTERNAL_EGRESS_PROXY;

function sanitizeHeaders(headers) {
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

  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || hopByHop.has(key.toLowerCase())) continue;
    next[key] = value;
  }
  return next;
}

function buildTargetUrl(req) {
  const requestPath = req.url || "/";
  const originalHost = req.headers["x-original-host"] || req.headers.host;
  const originalSni = req.headers["x-original-sni"];
  const originalProto = req.headers["x-original-proto"] || (originalSni ? "https" : "http");

  if (externalProxy) {
    return {
      mode: "external-proxy",
      url: new URL(requestPath, externalProxy).toString(),
      originalHost,
      originalProto,
    };
  }

  if (/^https?:\/\//i.test(requestPath)) {
    return {
      mode: "direct",
      url: requestPath,
      originalHost,
      originalProto,
    };
  }

  if (!originalHost || Array.isArray(originalHost)) {
    throw new Error("Missing original host for direct forwarding");
  }

  return {
    mode: "direct",
    url: `${originalProto}://${originalHost}${requestPath}`,
    originalHost,
    originalProto,
  };
}

const server = createServer(async (req, res) => {
  if ((req.url || "") === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const startedAt = Date.now();
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  try {
    const target = buildTargetUrl(req);
    const headers = sanitizeHeaders(req.headers);
    headers["x-egress-mode"] = target.mode;

    const response = await fetch(target.url, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const responseBody = Buffer.from(await response.arrayBuffer());
    const responseHeaders = sanitizeHeaders(Object.fromEntries(response.headers.entries()));

    res.writeHead(response.status, responseHeaders);
    res.end(responseBody);

    console.log(
      JSON.stringify({
        event: "egress_forward",
        mode: target.mode,
        method: req.method,
        path: req.url,
        targetUrl: target.url,
        originalHost: target.originalHost,
        status: response.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "egress_error",
        method: req.method,
        path: req.url,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress_forward_failed" }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "egress_started",
      port,
      mode: externalProxy ? "external-proxy" : "direct",
    }),
  );
});
