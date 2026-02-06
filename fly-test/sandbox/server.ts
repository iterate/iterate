import fs from "node:fs";
import { spawn } from "node:child_process";

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
  error?: string;
};

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

async function parseFetchInput(request: Request): Promise<FetchInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await request.json()) as { url?: string; method?: string; body?: string };
    return {
      url: String(data.url ?? "").trim(),
      method: String(data.method ?? "GET")
        .trim()
        .toUpperCase(),
      body: String(data.body ?? ""),
    };
  }

  const form = new URLSearchParams(await request.text());
  return {
    url: String(form.get("url") ?? "").trim(),
    method: String(form.get("method") ?? "GET")
      .trim()
      .toUpperCase(),
    body: String(form.get("body") ?? ""),
  };
}

async function fetchViaCurl(input: FetchInput): Promise<FetchResult> {
  const method = input.method;
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

  if (input.body.length > 0 && method !== "GET" && method !== "HEAD") {
    args.push("--header", "content-type: application/json");
    args.push("--data-raw", input.body);
  }
  args.push(input.url);

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
  const status = (lines.pop() ?? "").trim();
  const body = lines.join("\n");
  return {
    ok: true,
    status,
    body: body.slice(0, 3000),
    proofDetected: body.startsWith(PROOF_PREFIX),
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
      return new Response("sandbox ui\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/config") {
      return json({ defaultTargetUrl: DEFAULT_TARGET_URL });
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
          `FETCH_OK method=${input.method} url="${input.url}" status=${result.status ?? "unknown"} proof=${result.proofDetected ? "yes" : "no"}`,
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
