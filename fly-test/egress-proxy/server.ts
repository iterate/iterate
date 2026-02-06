import fs from "node:fs";
import indexPage from "./index.html";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");

type FetchPayload = {
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

async function parseTargetUrl(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { url?: string };
    return String(body.url ?? "").trim();
  }
  const text = await request.text();
  return String(new URLSearchParams(text).get("url") ?? "").trim();
}

async function fetchTarget(url: string): Promise<FetchPayload> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
  });
  const body = (await response.text()).slice(0, 2500);
  return {
    ok: true,
    status: response.status,
    body,
  };
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

      appendLog(`FETCH_START url="${target}"`);
      try {
        const result = await fetchTarget(target);
        appendLog(
          `FETCH_OK url="${target}" status=${result.status ?? 0} bytes=${result.body?.length ?? 0}`,
        );
        return json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(`FETCH_ERROR url="${target}" err="${message}"`);
        return json({ ok: false, error: message } satisfies FetchPayload, 502);
      }
    }

    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
