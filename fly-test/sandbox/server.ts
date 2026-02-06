import fs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
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
  const tempDir = fs.mkdtempSync("/tmp/fly-test-curl-");
  const headersPath = join(tempDir, "headers.txt");
  const bodyPath = join(tempDir, "body.txt");

  const status = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        "35",
        "--dump-header",
        headersPath,
        "--output",
        bodyPath,
        "--write-out",
        "%{http_code}",
        target,
      ],
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
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });

  const headers = fs.existsSync(headersPath) ? fs.readFileSync(headersPath, "utf8") : "";
  const body = fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath, "utf8") : "";
  fs.rmSync(tempDir, { recursive: true, force: true });

  const proofDetected =
    /(^|\n)x-iterate-mitm-proof:\s*1(\r?\n|$)/i.test(headers) || body.startsWith(PROOF_PREFIX);

  return {
    ok: true,
    status: status.length > 0 ? status : "unknown",
    body: body.slice(0, 2500),
    proofDetected,
  };
}

async function safeFetchViaCurl(target: string): Promise<FetchResult> {
  try {
    return await fetchViaCurl(target);
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
      const result = await safeFetchViaCurl(target);
      if (!result.ok) {
        appendLog(`FETCH_ERROR url=\"${target}\" err=\"${result.error ?? "unknown"}\"`);
        return json(result, 502);
      }
      appendLog(
        `FETCH_OK url=\"${target}\" status=${result.status ?? "unknown"} proof=${result.proofDetected ? "yes" : "no"}`,
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
