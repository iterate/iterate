import { createServer } from "node:http";

const port = Number.parseInt(process.env.OPENCODE_PORT ?? "4096", 10);

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "opencode-mock" }));
    return;
  }

  if (pathname === "/prompt" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        received: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "",
      }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0");
