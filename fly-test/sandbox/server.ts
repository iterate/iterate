import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = Number(process.env.SANDBOX_PORT ?? "8080");
const LOG_PATH = process.env.SANDBOX_LOG_PATH ?? "/tmp/sandbox-ui.log";
const DEFAULT_TARGET_URL = process.env.DEFAULT_TARGET_URL ?? "https://example.com/";
const EGRESS_HTTP_PROXY_URL = process.env.EGRESS_HTTP_PROXY_URL ?? "";
const WS_PROXY_URL = process.env.WS_PROXY_URL ?? "ws://egress-proxy:18081/api/ws/proxy";
const WS_UPSTREAM_URL = process.env.WS_UPSTREAM_URL ?? "wss://ws.ifelse.io";
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const INDEX_HTML = Bun.file(new URL("./index.html", import.meta.url));
const WS_EVENT_LIMIT = 250;

type FetchInput = {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
};

type FetchResult = {
  ok: boolean;
  status?: string;
  statusCode?: number;
  body?: string;
  error?: string;
};

type WsControlInput = {
  target: string;
};

type WsState = {
  connected: boolean;
  readyState: string;
  target: string;
  events: string[];
};

let wsClient: WebSocket | null = null;
let wsTarget = WS_UPSTREAM_URL;
const wsEvents: string[] = [];

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

function addWsEvent(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  wsEvents.push(line);
  if (wsEvents.length > WS_EVENT_LIMIT) {
    wsEvents.splice(0, wsEvents.length - WS_EVENT_LIMIT);
  }
  appendLog(`WS ${message}`);
}

function wsReadyStateLabel(): string {
  if (wsClient === null) return "closed";
  switch (wsClient.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      return "unknown";
  }
}

function getWsState(): WsState {
  return {
    connected: wsClient !== null && wsClient.readyState === WebSocket.OPEN,
    readyState: wsReadyStateLabel(),
    target: wsTarget,
    events: [...wsEvents],
  };
}

function parseWsUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function summarizeWsData(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 200);
  if (data instanceof Blob) return `[blob bytes=${data.size}]`;
  if (data instanceof ArrayBuffer) return `[arraybuffer bytes=${data.byteLength}]`;
  if (data instanceof Uint8Array) return `[bytes=${data.byteLength}]`;
  return String(data).slice(0, 200);
}

function closeWs(reason: string): void {
  if (wsClient === null) return;
  const current = wsClient;
  wsClient = null;
  addWsEvent(`CLIENT_CLOSE_REQUEST reason="${reason}"`);
  try {
    current.close(1000, reason.slice(0, 120));
  } catch {}
}

function buildWsProxyUrl(target: string): string {
  const proxy = new URL(WS_PROXY_URL);
  proxy.searchParams.set("target", target);
  return proxy.toString();
}

function connectWs(input: WsControlInput): WsState {
  const target = parseWsUrl(input.target);
  if (target === null) throw new Error("invalid target (use ws:// or wss://)");

  let proxyUrl: string;
  try {
    proxyUrl = buildWsProxyUrl(target.toString());
  } catch {
    throw new Error("invalid WS_PROXY_URL");
  }

  closeWs("reconnect");

  wsTarget = target.toString();
  addWsEvent(`CONNECT target="${wsTarget}"`);

  const client = new WebSocket(proxyUrl);
  wsClient = client;

  client.onopen = () => {
    addWsEvent("OPEN");
  };

  client.onmessage = (event) => {
    const summary = summarizeWsData(event.data);
    addWsEvent(`IN ${summary}`);
  };

  client.onerror = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    addWsEvent(`ERROR err="${message}"`);
  };

  client.onclose = (event) => {
    addWsEvent(`CLOSE code=${event.code} reason="${event.reason || ""}"`);
    if (wsClient === client) wsClient = null;
  };

  return getWsState();
}

function sendWsMessage(message: string): WsState {
  if (wsClient === null || wsClient.readyState !== WebSocket.OPEN) {
    throw new Error("socket not connected");
  }
  addWsEvent(`OUT ${message.slice(0, 200)}`);
  wsClient.send(message);
  return getWsState();
}

async function parseFetchInput(request: Request): Promise<FetchInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await request.json()) as {
      url?: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    };
    return {
      url: String(data.url ?? "").trim(),
      method: String(data.method ?? "GET")
        .trim()
        .toUpperCase(),
      body: String(data.body ?? ""),
      headers: data.headers && typeof data.headers === "object" ? data.headers : {},
    };
  }

  const form = new URLSearchParams(await request.text());
  return {
    url: String(form.get("url") ?? "").trim(),
    method: String(form.get("method") ?? "GET")
      .trim()
      .toUpperCase(),
    body: String(form.get("body") ?? ""),
    headers: {},
  };
}

async function fetchViaCurl(input: FetchInput): Promise<FetchResult> {
  const method = input.method;
  const targetUrl = EGRESS_HTTP_PROXY_URL.length > 0 ? EGRESS_HTTP_PROXY_URL : input.url;
  const args = [
    "-sS",
    "-L",
    "--max-time",
    "35",
    "--request",
    method,
    "--write-out",
    "\n%{http_code}",
  ];
  if (EGRESS_HTTP_PROXY_URL.length > 0) {
    args.push("--header", `x-proxy-target-url: ${input.url}`);
  }

  // Add custom headers
  for (const [key, value] of Object.entries(input.headers)) {
    if (key.trim().length > 0 && value.trim().length > 0) {
      args.push("--header", `${key}: ${value}`);
    }
  }

  if (input.body.length > 0 && method !== "GET" && method !== "HEAD") {
    // Only add content-type if not already in custom headers
    const hasContentType = Object.keys(input.headers).some(
      (k) => k.toLowerCase() === "content-type",
    );
    if (!hasContentType) {
      args.push("--header", "content-type: application/json");
    }
    args.push("--data-raw", input.body);
  }
  args.push(targetUrl);

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(message.length > 0 ? message : `curl_exit=${code ?? "unknown"}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });

  const lines = raw.split(/\r?\n/);
  const statusRaw = (lines.pop() ?? "").trim();
  const statusCode = Number.parseInt(statusRaw, 10);
  const body = lines.join("\n");
  return {
    ok: true,
    status: statusRaw,
    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
    body: body.slice(0, 3000),
  };
}

async function safeFetchViaCurl(input: FetchInput): Promise<FetchResult> {
  try {
    return await fetchViaCurl(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message,
    };
  }
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} port=${PORT}`);

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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

    if (url.pathname === "/api/config") {
      return json({
        defaultTargetUrl: DEFAULT_TARGET_URL,
        wsDefaultTarget: WS_UPSTREAM_URL,
      });
    }

    if (url.pathname === "/api/ws/state") {
      return json(getWsState());
    }

    if (url.pathname === "/api/ws/disconnect" && request.method === "POST") {
      closeWs("manual disconnect");
      return json(getWsState());
    }

    if (url.pathname === "/api/ws/connect" && request.method === "POST") {
      let data: Record<string, unknown>;
      try {
        data = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const input: WsControlInput = {
        target: String(data["target"] ?? WS_UPSTREAM_URL).trim(),
      };

      try {
        return json(connectWs(input));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 400);
      }
    }

    if (url.pathname === "/api/ws/send" && request.method === "POST") {
      let data: Record<string, unknown>;
      try {
        data = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const message = String(data["message"] ?? "");
      if (message.trim().length === 0) {
        return json({ error: "message required" }, 400);
      }

      try {
        return json(sendWsMessage(message));
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return json({ error: err }, 400);
      }
    }

    if (url.pathname === "/api/fetch" && request.method === "POST") {
      const input = await parseFetchInput(request);
      if (input.url.length === 0) return json({ ok: false, error: "missing url" }, 400);
      if (!ALLOWED_METHODS.has(input.method)) {
        return json({ ok: false, error: "unsupported method" }, 400);
      }

      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        return json({ ok: false, error: "invalid url" }, 400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return json({ ok: false, error: "only http/https supported" }, 400);
      }

      appendLog(
        `FETCH_START method=${input.method} url="${input.url}" body_bytes=${input.body.length}`,
      );
      const result = await safeFetchViaCurl(input);
      if (result.ok) {
        appendLog(
          `FETCH_OK method=${input.method} url="${input.url}" status=${result.status ?? "unknown"}`,
        );
      } else {
        appendLog(
          `FETCH_ERROR method=${input.method} url="${input.url}" err="${result.error ?? "unknown"}"`,
        );
      }
      return json(result, result.ok ? 200 : 502);
    }

    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`LISTEN port=${PORT}`);
