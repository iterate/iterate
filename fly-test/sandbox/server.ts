import fs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import dns from "node:dns/promises";
import indexPage from "./index.html";

const PORT = Number(process.env.SANDBOX_PORT ?? "8080");
const LOG_PATH = process.env.SANDBOX_LOG_PATH ?? "/tmp/sandbox-ui.log";
const DEFAULT_TARGET_URL = process.env.DEFAULT_TARGET_URL ?? "https://example.com/";
const PROOF_PREFIX = process.env.PROOF_PREFIX ?? "__ITERATE_MITM_PROOF__\n";
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

type FetchInput = {
  url: string;
  method: string;
  body: string;
};

type FetchResult = {
  ok: boolean;
  status?: string;
  body?: string;
  proofDetected?: boolean;
  responseHeaders?: Record<string, string>;
  requestId?: string;
  method?: string;
  targetUrl?: string;
  error?: string;
};

function nowUtc(): string {
  return new Date().toISOString();
}

function appendLog(message: string): void {
  const line = `${nowUtc()} ${message}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function parseFetchInput(request: Request): Promise<FetchInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { url?: string; method?: string; body?: string };
    return {
      url: String(body.url ?? "").trim(),
      method: String(body.method ?? "GET")
        .trim()
        .toUpperCase(),
      body: String(body.body ?? ""),
    };
  }
  const text = await request.text();
  const form = new URLSearchParams(text);
  return {
    url: String(form.get("url") ?? "").trim(),
    method: String(form.get("method") ?? "GET")
      .trim()
      .toUpperCase(),
    body: String(form.get("body") ?? ""),
  };
}

function parseResponseHeaders(rawHeaders: string): Record<string, string> {
  const blocks = rawHeaders
    .split(/\r?\n\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("HTTP/"));
  const block = blocks.length > 0 ? (blocks.at(-1) ?? "") : rawHeaders;
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (value.length > 0) out[key] = value;
  }
  return out;
}

function pickInterestingHeaders(input: Record<string, string>): Record<string, string> {
  const keep = [
    "content-type",
    "location",
    "x-iterate-mitm-proof",
    "x-iterate-mitm-request-id",
    "x-iterate-mitm-target-url",
    "x-iterate-mitm-body-modified",
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = input[key];
    if (value) out[key] = value;
  }
  return out;
}

async function fetchViaCurl(input: FetchInput): Promise<FetchResult> {
  const tempDir = fs.mkdtempSync("/tmp/fly-test-curl-");
  const headersPath = join(tempDir, "headers.txt");
  const bodyPath = join(tempDir, "body.txt");
  const method = input.method;
  const target = input.url;
  const body = input.body;
  const useBody = body.length > 0 && method !== "GET" && method !== "HEAD";
  const args = [
    "-sS",
    "-L",
    "--max-time",
    "35",
    "--request",
    method,
    "--dump-header",
    headersPath,
    "--output",
    bodyPath,
    "--write-out",
    "%{http_code}",
  ];
  if (useBody) {
    args.push("--header", "content-type: application/json");
    args.push("--data-raw", body);
  }
  args.push(target);
  try {
    const status = await new Promise<string>((resolve, reject) => {
      const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error: Error) => reject(error));
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `curl_exit=${code}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      });
    });

    const headersRaw = fs.existsSync(headersPath) ? fs.readFileSync(headersPath, "utf8") : "";
    const bodyRaw = fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath, "utf8") : "";
    const parsedHeaders = parseResponseHeaders(headersRaw);
    const interestingHeaders = pickInterestingHeaders(parsedHeaders);

    const proofDetected =
      /(^|\n)x-iterate-mitm-proof:\s*1(\r?\n|$)/i.test(headersRaw) ||
      bodyRaw.startsWith(PROOF_PREFIX);

    return {
      ok: true,
      status: status.length > 0 ? status : "unknown",
      body: bodyRaw.slice(0, 2500),
      proofDetected,
      responseHeaders: interestingHeaders,
      requestId: interestingHeaders["x-iterate-mitm-request-id"],
      method,
      targetUrl: target,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

async function probeDns(target: URL): Promise<void> {
  try {
    const result = await dns.lookup(target.hostname, { all: true });
    const addresses = result.map((entry) => entry.address).join(",");
    appendLog(`DNS_PROBE_OK host="${target.hostname}" addrs="${addresses}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`DNS_PROBE_ERROR host="${target.hostname}" err="${message}"`);
  }
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(
  `BOOT pid=${process.pid} port=${PORT} http_proxy="${process.env.HTTP_PROXY ?? ""}" https_proxy="${process.env.HTTPS_PROXY ?? ""}"`,
);

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  routes: {
    "/": indexPage,
  },
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/api/config") {
      return json({ defaultTargetUrl: DEFAULT_TARGET_URL });
    }

    if (url.pathname === "/api/fetch" && request.method === "POST") {
      const input = await parseFetchInput(request);
      const target = input.url;
      const method = input.method;
      const body = input.body;
      if (target.length === 0) return json({ ok: false, error: "missing url" }, 400);
      if (!ALLOWED_METHODS.has(method))
        return json({ ok: false, error: "unsupported method" }, 400);

      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return json({ ok: false, error: "invalid url" }, 400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return json({ ok: false, error: "only http/https supported" }, 400);
      }

      appendLog(`FETCH_START method=${method} url="${target}" body_bytes=${body.length}`);
      await probeDns(parsed);
      const result = await safeFetchViaCurl(input);
      if (!result.ok) {
        appendLog(
          `FETCH_ERROR method=${method} url="${target}" err="${result.error ?? "unknown"}"`,
        );
        return json(result, 502);
      }
      appendLog(
        `FETCH_OK method=${method} url="${target}" status=${result.status ?? "unknown"} proof=${result.proofDetected ? "yes" : "no"} request_id=${result.requestId ?? "-"}`,
      );
      return json(result);
    }

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`LISTEN port=${PORT}`);
