import http from "node:http";

const PORT = 18090;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(error));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  const startedAt = new Date().toISOString();
  const url = new URL(req.url ?? "/", "http://public-http:18090");

  if (url.pathname === "/") {
    json(res, 200, {
      ok: true,
      service: "public-http",
      route: "/",
      method: req.method ?? "GET",
      ts: startedAt,
    });
    return;
  }

  if (url.pathname === "/text") {
    text(res, 200, `plain-text payload from public-http at ${startedAt}\n`);
    return;
  }

  if (url.pathname === "/html") {
    html(
      res,
      200,
      `<!doctype html><html><body><h1>public-http html</h1><p>ts=${startedAt}</p></body></html>`,
    );
    return;
  }

  if (url.pathname === "/slow") {
    const delayMs = Number(url.searchParams.get("ms") ?? "7000");
    await wait(Number.isFinite(delayMs) ? Math.max(0, Math.min(delayMs, 120000)) : 7000);
    json(res, 200, {
      ok: true,
      service: "public-http",
      route: "/slow",
      delayedMs: delayMs,
      ts: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/echo") {
    const body = await readRequestBody(req);
    json(res, 200, {
      ok: true,
      service: "public-http",
      route: "/echo",
      method: req.method ?? "GET",
      url: url.pathname + url.search,
      headers: req.headers,
      body,
      ts: startedAt,
    });
    return;
  }

  json(res, 404, {
    ok: false,
    error: "not found",
    route: url.pathname,
    ts: startedAt,
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`public-http listening on ${PORT}\n`);
});
