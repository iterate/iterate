#!/usr/bin/env tsx
import { createServer } from "node:http";

type RecordEntry = {
  method: string;
  path: string;
  host: string;
  headers: Record<string, string | string[]>;
  body: string;
  createdAt: string;
};

const port = Number.parseInt(process.env.JONASLAND_MOCK_EGRESS_PORT ?? "19099", 10);
const records: RecordEntry[] = [];
const INTERNAL_PATHS = new Set(["/healthz", "/records"]);

function toHeaders(
  headers: import("node:http").IncomingHttpHeaders,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value as string | string[]]),
  );
}

const server = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    const body = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    const url = new URL(req.url ?? "/", "http://localhost");

    const path = `${url.pathname}${url.search}`;
    if (!INTERNAL_PATHS.has(url.pathname)) {
      const entry: RecordEntry = {
        method: req.method ?? "GET",
        path,
        host: req.headers.host ?? "",
        headers: toHeaders(req.headers),
        body,
        createdAt: new Date().toISOString(),
      };
      records.push(entry);
      process.stdout.write(`[mock-egress] ${entry.method} ${entry.path} host=${entry.host}\n`);
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/records") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ total: records.length, records }, null, 2));
      return;
    }

    if (url.pathname === "/v1/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_demo",
          object: "response",
          status: "completed",
          model: "gpt-4o-mini",
          output_text: "The answer is 42",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "The answer is 42" }],
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/api/chat.postMessage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: "123.456" }));
      return;
    }

    res.writeHead(599, { "content-type": "text/plain" });
    res.end("unmatched");
  })().catch((error) => {
    process.stderr.write(
      `[mock-egress] request handler failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: "internal_error" }));
  });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`[mock-egress] listening on http://0.0.0.0:${String(port)}\n`);
  process.stdout.write(
    "[mock-egress] endpoints: /healthz, /records, /v1/responses, /api/chat.postMessage\n",
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
