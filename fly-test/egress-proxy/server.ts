import fs from "node:fs";
import indexPage from "./index.html";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");
const MITM_CA_CERT_PATH = process.env.MITM_CA_CERT_PATH ?? "/data/mitm/ca.crt";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authentication",
]);

function nowUtc(): string {
  return new Date().toISOString();
}

function appendLog(message: string): void {
  const line = `${nowUtc()} ${message}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function getTail(path: string, maxLines: number): string[] {
  if (!fs.existsSync(path)) return [];
  const data = fs.readFileSync(path, "utf8");
  const lines = data.split("\n").filter((line) => line.length > 0);
  return lines.slice(-maxLines);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sanitizeInboundHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host") continue;
    if (lower === "content-length") continue;
    if (lower.startsWith("x-iterate-")) continue;
    headers.append(key, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function sanitizeOutboundHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-length") continue;
    if (lower === "transfer-encoding") continue;
    out.append(key, value);
  }
  return out;
}

async function handleTransform(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();
  const target = (request.headers.get("x-iterate-target-url") ?? "").trim();
  if (target.length === 0) return json({ error: "missing url" }, 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "invalid url" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ error: "unsupported protocol" }, 400);
  }

  const requestHeaders = sanitizeInboundHeaders(request.headers);
  const init: RequestInit = {
    method,
    headers: requestHeaders,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }

  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, init);
    const responseHeaders = sanitizeOutboundHeaders(upstream.headers);
    responseHeaders.set("x-iterate-mitm-proof", "1");

    appendLog(
      `TRANSFORM_OK method=${method} url="${target}" status=${upstream.status} duration_ms=${Date.now() - startedAt}`,
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`TRANSFORM_ERROR method=${method} url="${target}" err="${message}"`);
    return json({ error: message }, 502);
  }
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} viewer_port=${VIEWER_PORT}`);

Bun.serve({
  port: VIEWER_PORT,
  hostname: "::",
  routes: {
    "/": indexPage,
  },
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/ca.crt") {
      if (!fs.existsSync(MITM_CA_CERT_PATH)) {
        return new Response("ca cert not ready\n", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const body = fs.readFileSync(MITM_CA_CERT_PATH);
      return new Response(body, {
        headers: {
          "content-type": "application/x-pem-file",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/tail") {
      const requestedLines = Number(url.searchParams.get("lines") ?? "300");
      const maxLines = Number.isNaN(requestedLines)
        ? 300
        : Math.max(1, Math.min(requestedLines, 1000));
      const text = `${getTail(LOG_PATH, maxLines).join("\n")}\n`;
      return new Response(text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/transform") {
      return handleTransform(request);
    }

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
