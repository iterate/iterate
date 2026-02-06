import fs from "node:fs";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");
const MITM_CA_CERT_PATH = process.env.MITM_CA_CERT_PATH ?? "/data/mitm/ca.crt";
const PROOF_PREFIX = process.env.PROOF_PREFIX ?? "__ITERATE_MITM_PROOF__\n";
const TRANSFORM_TIMEOUT_MS = Number(process.env.TRANSFORM_TIMEOUT_MS ?? "5000");
const INDEX_HTML = Bun.file(new URL("./index.html", import.meta.url));

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

function appendLog(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
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
    if (lower === "forwarded") continue;
    if (lower === "x-forwarded-for") continue;
    if (lower === "x-forwarded-host") continue;
    if (lower === "x-forwarded-proto") continue;
    if (lower === "x-forwarded-port") continue;
    headers.append(key, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function sanitizeOutboundHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-length") continue;
    headers.append(key, value);
  }
  return headers;
}

function isTextLike(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript")
  );
}

function getTail(maxLines: number): string {
  if (!fs.existsSync(LOG_PATH)) return "";
  const lines = fs
    .readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  return `${lines.slice(-maxLines).join("\n")}\n`;
}

function deriveTarget(request: Request, url: URL): string | null {
  const host = (request.headers.get("x-forwarded-host") ?? "").trim();
  const proto = (request.headers.get("x-forwarded-proto") ?? "").trim().toLowerCase();
  if (host.length === 0 || proto.length === 0) return null;
  if (proto !== "http" && proto !== "https") return null;

  try {
    return new URL(`${proto}://${host}${url.pathname}${url.search}`).toString();
  } catch {
    return null;
  }
}

async function handleTransform(request: Request, target: string): Promise<Response> {
  const method = request.method.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "invalid url" }, 400);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ error: "unsupported protocol" }, 400);
  }

  appendLog(`MITM_REQUEST method=${method} target="${target}"`);

  if (parsed.hostname === "iterate.com" || parsed.hostname.endsWith(".iterate.com")) {
    appendLog(`POLICY_BLOCK method=${method} target="${target}"`);
    return new Response("policy violation\n", {
      status: 451,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const init: RequestInit = {
    method,
    headers: sanitizeInboundHeaders(request.headers),
    redirect: "manual",
    signal: AbortSignal.timeout(
      Number.isFinite(TRANSFORM_TIMEOUT_MS) ? TRANSFORM_TIMEOUT_MS : 5000,
    ),
  };
  if (method !== "GET" && method !== "HEAD") init.body = request.body;

  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, init);
    const contentType = upstream.headers.get("content-type") ?? "";
    const headers = sanitizeOutboundHeaders(upstream.headers);

    let bodyOut: BodyInit | null = upstream.body;
    if (method === "HEAD") {
      bodyOut = null;
    } else if (isTextLike(contentType)) {
      const raw = await upstream.text();
      bodyOut = `${PROOF_PREFIX}${raw}`;
    }

    appendLog(
      `TRANSFORM_OK method=${method} target="${target}" status=${upstream.status} duration_ms=${Date.now() - startedAt}`,
    );

    return new Response(bodyOut, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(
      `TRANSFORM_ERROR method=${method} target="${target}" duration_ms=${Date.now() - startedAt} err="${message}"`,
    );
    return json({ error: message }, 502);
  }
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} viewer_port=${VIEWER_PORT}`);

Bun.serve({
  port: VIEWER_PORT,
  hostname: "::",
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = deriveTarget(request, url);
    if (target !== null) {
      return handleTransform(request, target);
    }

    if (url.pathname === "/") {
      return new Response(INDEX_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ca.crt") {
      if (!fs.existsSync(MITM_CA_CERT_PATH)) {
        return new Response("ca cert not ready\n", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(fs.readFileSync(MITM_CA_CERT_PATH), {
        headers: {
          "content-type": "application/x-pem-file",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/tail") {
      const requested = Number(url.searchParams.get("lines") ?? "300");
      const lines = Number.isFinite(requested) ? Math.max(1, Math.min(1000, requested)) : 300;
      return new Response(getTail(lines), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
