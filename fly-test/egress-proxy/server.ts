import fs from "node:fs";
import indexPage from "./index.html";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");
const MITM_CA_CERT_PATH = process.env.MITM_CA_CERT_PATH ?? "/data/mitm/ca.crt";
const PROOF_PREFIX = process.env.PROOF_PREFIX ?? "__ITERATE_MITM_PROOF__\n";

type TransformRequest = {
  method: string;
  url: string;
  headers: Record<string, string[]>;
  bodyBase64?: string;
};

type TransformResponse = {
  status: number;
  headers: Record<string, string[]>;
  bodyBase64: string;
};

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

function sanitizeHeaders(input: Record<string, string[]>): Headers {
  const headers = new Headers();
  for (const [key, values] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host") continue;
    if (lower === "content-length") continue;
    for (const value of values) {
      headers.append(key, value);
    }
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function headersToRecord(headers: Headers): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "content-length") continue;
    if (lower === "transfer-encoding") continue;
    if (lower === "content-encoding") continue;
    if (out[key]) {
      out[key].push(value);
    } else {
      out[key] = [value];
    }
  }
  return out;
}

async function handleTransform(request: Request): Promise<Response> {
  let payload: TransformRequest;
  try {
    payload = (await request.json()) as TransformRequest;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const method = String(payload.method ?? "GET").toUpperCase();
  const target = String(payload.url ?? "").trim();
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

  const requestHeaders = sanitizeHeaders(payload.headers ?? {});
  let requestBody: Blob | undefined;
  let requestBytes = 0;
  if (
    payload.bodyBase64 &&
    payload.bodyBase64.length > 0 &&
    method !== "GET" &&
    method !== "HEAD"
  ) {
    const decoded = Buffer.from(payload.bodyBase64, "base64");
    requestBytes = decoded.length;
    requestBody = new Blob([decoded]);
  }

  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, {
      method,
      headers: requestHeaders,
      body: requestBody,
      redirect: "manual",
    });

    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    const prefixedBody = Buffer.concat([Buffer.from(PROOF_PREFIX, "utf8"), upstreamBody]);
    const responseHeaders = headersToRecord(upstream.headers);
    responseHeaders["x-iterate-mitm-proof"] = ["1"];
    responseHeaders["content-length"] = [String(prefixedBody.length)];

    appendLog(
      `TRANSFORM_OK method=${method} url="${target}" status=${upstream.status} req_bytes=${requestBytes} up_bytes=${upstreamBody.length} out_bytes=${prefixedBody.length} duration_ms=${Date.now() - startedAt}`,
    );

    const response: TransformResponse = {
      status: upstream.status,
      headers: responseHeaders,
      bodyBase64: prefixedBody.toString("base64"),
    };
    return json(response);
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

    if (url.pathname === "/transform" && request.method === "POST") {
      return handleTransform(request);
    }

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
