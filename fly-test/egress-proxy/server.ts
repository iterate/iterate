import fs from "node:fs";
import indexPage from "./index.html";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");
const MITM_CA_CERT_PATH = process.env.MITM_CA_CERT_PATH ?? "/data/mitm/ca.crt";
const BODY_PREVIEW_MAX = Number(process.env.BODY_PREVIEW_MAX ?? "280");

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

function compactPreview(input: string, maxChars = BODY_PREVIEW_MAX): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

function headerSnapshot(input: Headers): Record<string, string> {
  const keep = [
    "host",
    "user-agent",
    "accept",
    "content-type",
    "content-length",
    "x-iterate-target-url",
    "x-iterate-request-host",
    "x-iterate-remote-addr",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "server",
    "location",
    "cache-control",
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = input.get(key);
    if (value) out[key] = compactPreview(value, 180);
  }
  return out;
}

function shouldTreatAsText(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (value.startsWith("text/")) return true;
  if (value.includes("json")) return true;
  if (value.includes("xml")) return true;
  if (value.includes("javascript")) return true;
  return false;
}

function buildRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) return trimmed.slice(1, end);
  }
  const parts = trimmed.split(":");
  if (parts.length > 1) return parts[0] ?? trimmed;
  return trimmed;
}

function isPolicyBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "iterate.com" || host.endsWith(".iterate.com");
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
  const requestId = buildRequestId();
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

  if (isPolicyBlockedHost(parsed.hostname)) {
    const blockedBody =
      "<!doctype html><html><body><h1>policy violation</h1><p>Access to this destination is forbidden by egress policy.</p></body></html>";
    const blockedHeaders = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-iterate-mitm-proof": "1",
      "x-iterate-mitm-policy": "deny-iterate.com",
      "x-iterate-mitm-body-modified": "policy-violation",
      "x-iterate-mitm-request-id": requestId,
      "x-iterate-mitm-target-url": target,
    });
    appendLog(
      `POLICY_BLOCK id=${requestId} method=${method} target="${target}" host="${parsed.hostname}" rule="deny-iterate.com"`,
    );
    return new Response(blockedBody, {
      status: 451,
      headers: blockedHeaders,
    });
  }

  const requestHeaders = sanitizeInboundHeaders(request.headers);
  let requestBodyPreview = "";
  if (method !== "GET" && method !== "HEAD") {
    try {
      requestBodyPreview = compactPreview(await request.clone().text());
    } catch {
      requestBodyPreview = "<unavailable>";
    }
  }
  appendLog(
    `INSPECT_REQUEST id=${requestId} method=${method} target="${target}" inbound_headers=${JSON.stringify(headerSnapshot(request.headers))} upstream_headers=${JSON.stringify(headerSnapshot(requestHeaders))} body_preview=${JSON.stringify(requestBodyPreview)}`,
  );

  const init: RequestInit = {
    method,
    headers: requestHeaders,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }

  const timeoutMsRaw = Number(process.env.TRANSFORM_TIMEOUT_MS ?? "5000");
  const timeoutMs = Number.isFinite(timeoutMsRaw)
    ? Math.max(500, Math.min(timeoutMsRaw, 120000))
    : 5000;
  const signal = AbortSignal.timeout(timeoutMs);
  init.signal = signal;

  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, init);
    const upstreamContentType = upstream.headers.get("content-type") ?? "";
    const responseHeaders = sanitizeOutboundHeaders(upstream.headers);
    responseHeaders.set("x-iterate-mitm-proof", "1");
    responseHeaders.set("x-iterate-mitm-request-id", requestId);
    responseHeaders.set("x-iterate-mitm-target-url", target);

    let bodyOut: BodyInit | null = upstream.body;
    let bodyPreview = "<non-text>";
    let bodyMutation = "none";

    if (method === "HEAD") {
      bodyOut = null;
      bodyPreview = "<head-no-body>";
    } else if (shouldTreatAsText(upstreamContentType)) {
      const rawBody = await upstream.text();
      bodyPreview = compactPreview(rawBody);
      if (upstreamContentType.toLowerCase().includes("text/html")) {
        bodyOut = `<!-- iterate-mitm request_id=${requestId} -->\n${rawBody}`;
        bodyMutation = "html-comment-prefix";
      } else if (upstreamContentType.toLowerCase().startsWith("text/plain")) {
        bodyOut = `__ITERATE_MITM_PROOF__ request_id=${requestId}\n${rawBody}`;
        bodyMutation = "text-prefix";
      } else {
        bodyOut = rawBody;
      }
    }

    responseHeaders.set("x-iterate-mitm-body-modified", bodyMutation);
    responseHeaders.delete("content-length");
    appendLog(
      `INSPECT_RESPONSE id=${requestId} method=${method} target="${target}" status=${upstream.status} content_type=${JSON.stringify(upstreamContentType)} headers=${JSON.stringify(headerSnapshot(responseHeaders))} body_preview=${JSON.stringify(bodyPreview)} body_mutation=${bodyMutation}`,
    );

    appendLog(
      `TRANSFORM_OK id=${requestId} method=${method} url="${target}" status=${upstream.status} duration_ms=${Date.now() - startedAt}`,
    );

    return new Response(bodyOut, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    const timedOut =
      (error instanceof DOMException && error.name === "TimeoutError") ||
      message.toLowerCase().includes("timed out") ||
      message.toLowerCase().includes("timeout");
    appendLog(
      `${timedOut ? "TRANSFORM_TIMEOUT" : "TRANSFORM_ERROR"} id=${requestId} method=${method} url="${target}" duration_ms=${durationMs} err="${message}"`,
    );
    return json({ error: message, timedOut, requestId }, timedOut ? 504 : 502);
  }
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} viewer_port=${VIEWER_PORT}`);

Bun.serve({
  port: VIEWER_PORT,
  hostname: "::",
  idleTimeout: 120,
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
