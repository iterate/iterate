import fs from "node:fs";
import { spawn } from "node:child_process";
import indexPage from "./index.html";

const PORT = Number(process.env.SANDBOX_PORT ?? "8080");
const LOG_PATH = process.env.SANDBOX_LOG_PATH ?? "/tmp/sandbox-ui.log";
const DEFAULT_TARGET_URL = process.env.DEFAULT_TARGET_URL ?? "https://example.com/";
const PROOF_PREFIX = process.env.PROOF_PREFIX ?? "__ITERATE_MITM_PROOF__\n";

type FetchResult = {
  ok: boolean;
  status?: string;
  body?: string;
  proofDetected?: boolean;
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

async function fetchViaCurl(target: string): Promise<FetchResult> {
  const marker = "\n__STATUS__:";
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "curl",
      ["-sS", "-L", "--max-time", "35", "-w", `${marker}%{http_code}\n`, target],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
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

  const idx = output.lastIndexOf(marker);
  if (idx < 0) {
    return { ok: true, status: "unknown", body: output.slice(0, 2500), proofDetected: false };
  }

  const status = output.slice(idx + marker.length).trim();
  const body = output.slice(0, idx);
  return {
    ok: true,
    status,
    body: body.slice(0, 2500),
    proofDetected: body.startsWith(PROOF_PREFIX),
  };
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(
  `BOOT pid=${process.pid} port=${PORT} http_proxy=\"${process.env.HTTP_PROXY ?? ""}\" https_proxy=\"${process.env.HTTPS_PROXY ?? ""}\"`,
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

      appendLog(`FETCH_START url=\"${target}\"`);
      try {
        const result = await fetchViaCurl(target);
        appendLog(
          `FETCH_OK url=\"${target}\" status=${result.status ?? "unknown"} proof=${result.proofDetected ? "yes" : "no"}`,
        );
        return json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(`FETCH_ERROR url=\"${target}\" err=\"${message}\"`);
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
