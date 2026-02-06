import fs from "node:fs";
import { spawn } from "node:child_process";
import indexPage from "./index.html";

const PORT = Number(process.env.SANDBOX_PORT ?? "8080");
const EGRESS_PROXY_URL = process.env.EGRESS_PROXY_URL ?? "";
const LOG_PATH = process.env.SANDBOX_LOG_PATH ?? "/tmp/sandbox-ui.log";
const DEFAULT_TARGET_URL = process.env.DEFAULT_TARGET_URL ?? "http://neverssl.com/";

if (EGRESS_PROXY_URL.length === 0) {
  process.stderr.write("Missing EGRESS_PROXY_URL\n");
  process.exit(1);
}

type FetchResult = {
  ok: boolean;
  status?: number;
  body?: string;
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

async function parseTargetUrl(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { url?: string };
    return String(body.url ?? "").trim();
  }
  const text = await request.text();
  return String(new URLSearchParams(text).get("url") ?? "").trim();
}

async function fetchViaEgress(target: string): Promise<FetchResult> {
  const endpoint = `${EGRESS_PROXY_URL.replace(/\/$/, "")}/api/fetch`;
  const payload = JSON.stringify({ url: target });
  const body = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "-sS",
        "--max-time",
        "30",
        "-H",
        "content-type: application/json",
        "--data",
        payload,
        endpoint,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });

  const data = JSON.parse(body) as FetchResult;
  if (!data.ok) throw new Error(data.error ?? "egress fetch failed");
  return data;
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} port=${PORT} egress="${EGRESS_PROXY_URL}"`);

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
      const target = await parseTargetUrl(request);
      if (target.length === 0) return json({ ok: false, error: "missing url" }, 400);

      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return json({ ok: false, error: "invalid url" }, 400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return json({ ok: false, error: "only http/https supported" }, 400);
      }

      appendLog(`FETCH_START url="${target}" egress="${EGRESS_PROXY_URL}"`);
      try {
        const result = await fetchViaEgress(target);
        appendLog(`FETCH_OK url="${target}" status=${result.status ?? 0}`);
        return json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(`FETCH_ERROR url="${target}" err="${message}"`);
        return json({ ok: false, error: message } satisfies FetchResult, 502);
      }
    }

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`LISTEN port=${PORT}`);
