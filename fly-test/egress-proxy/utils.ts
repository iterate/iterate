import fs from "node:fs";

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

export type ProxySocketData = {
  requestId: string;
  target: string;
  upstream: WebSocket | null;
  holdTimers: Set<ReturnType<typeof setTimeout>>;
};

export type WsPayload = {
  bytes: number;
  text: string | null;
  payload: string | Uint8Array;
};

export type Logger = {
  appendLog: (message: string) => void;
  getTail: (maxLines: number) => string;
};

export function createLogger(logPath: string): Logger {
  fs.mkdirSync("/tmp", { recursive: true });
  fs.appendFileSync(logPath, "");

  const appendLog = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}`;
    process.stdout.write(`${line}\n`);
    fs.appendFileSync(logPath, `${line}\n`);
  };

  const getTail = (maxLines: number): string => {
    if (!fs.existsSync(logPath)) return "";
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    return `${lines.slice(-maxLines).join("\n")}\n`;
  };

  return { appendLog, getTail };
}

let requestCounter = 0;

export function nextRequestId(scope: "http" | "ws"): string {
  requestCounter += 1;
  return `${scope}-${String(requestCounter).padStart(6, "0")}`;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function isBlockedHost(hostname: string): boolean {
  return hostname === "iterate.com" || hostname.endsWith(".iterate.com");
}

export function parseWsTarget(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeKnownWsMessage(message: string | Buffer | Uint8Array): WsPayload {
  if (typeof message === "string") {
    return {
      bytes: Buffer.byteLength(message, "utf8"),
      text: message,
      payload: message,
    };
  }

  const bytes = new Uint8Array(message);
  let text: string | null = null;
  try {
    text = Buffer.from(bytes).toString("utf8");
  } catch {
    text = null;
  }

  return {
    bytes: bytes.byteLength,
    text,
    payload: bytes,
  };
}

export async function normalizeUnknownWsMessage(message: unknown): Promise<WsPayload> {
  if (typeof message === "string") {
    return {
      bytes: Buffer.byteLength(message, "utf8"),
      text: message,
      payload: message,
    };
  }

  if (message instanceof Uint8Array || Buffer.isBuffer(message)) {
    return normalizeKnownWsMessage(message);
  }

  if (message instanceof Blob) {
    const bytes = new Uint8Array(await message.arrayBuffer());
    let text: string | null = null;
    try {
      text = Buffer.from(bytes).toString("utf8");
    } catch {
      text = null;
    }
    return {
      bytes: bytes.byteLength,
      text,
      payload: bytes,
    };
  }

  const fallback = String(message);
  return {
    bytes: Buffer.byteLength(fallback, "utf8"),
    text: fallback,
    payload: fallback,
  };
}

export function payloadSummary(payload: WsPayload): string {
  if (payload.text === null) return `bytes=${payload.bytes} kind=binary`;
  return `bytes=${payload.bytes} text="${payload.text.replaceAll("\n", "\\n").replaceAll("\r", "\\r").slice(0, 160)}"`;
}

export function rewriteU2c(payload: WsPayload, from: string, to: string): WsPayload {
  if (from.length === 0 || payload.text === null || !payload.text.includes(from)) return payload;
  const rewritten = payload.text.replaceAll(from, to);
  return {
    bytes: Buffer.byteLength(rewritten, "utf8"),
    text: rewritten,
    payload: rewritten,
  };
}

export function closeUpstream(data: ProxySocketData): void {
  if (data.upstream === null) return;
  if (
    data.upstream.readyState === WebSocket.OPEN ||
    data.upstream.readyState === WebSocket.CONNECTING
  ) {
    try {
      data.upstream.close(1000, "proxy-closed");
    } catch {}
  }
  data.upstream = null;
}

export function sanitizeInboundHeaders(input: Headers): Headers {
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
    if (lower === "x-proxy-target-url") continue;
    headers.append(key, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

export function sanitizeOutboundHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-length") continue;
    headers.append(key, value);
  }
  return headers;
}

export function isTextLike(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript")
  );
}

export function deriveTarget(request: Request): string | null {
  const header = (request.headers.get("x-proxy-target-url") ?? "").trim();
  if (header.length === 0) return null;
  try {
    const parsed = new URL(header);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
