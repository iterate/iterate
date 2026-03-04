import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const token = "local-caddymanager-token";

function parsePort(value, key) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key}: ${value}`);
  }
  return parsed;
}

function getEnv() {
  const host = process.env.CADDYMANAGER_HOST?.trim() || "0.0.0.0";
  const port = parsePort(process.env.CADDYMANAGER_PORT || "8501", "CADDYMANAGER_PORT");
  const targetServerName = process.env.CADDYMANAGER_TARGET_SERVER_NAME?.trim() || "local-caddy";
  const targetApiUrl = process.env.CADDYMANAGER_TARGET_API_URL?.trim() || "http://127.0.0.1";
  const targetApiPort = parsePort(
    process.env.CADDYMANAGER_TARGET_API_PORT || "2019",
    "CADDYMANAGER_TARGET_API_PORT",
  );
  const targetAdminApiPath = process.env.CADDYMANAGER_TARGET_ADMIN_API_PATH?.trim() || "/config/";

  return {
    host,
    port,
    targetServerName,
    targetApiUrl,
    targetApiPort,
    targetAdminApiPath,
  };
}

function toJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function toHtml(res, statusCode, html) {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function splitPath(urlString) {
  const url = new URL(urlString || "/", "http://127.0.0.1");
  return {
    url,
    parts: url.pathname.split("/").filter(Boolean),
  };
}

function toServerResponseShape(entry) {
  return {
    id: entry.id,
    _id: entry.id,
    name: entry.name,
    apiUrl: entry.apiUrl,
    apiPort: entry.apiPort,
    adminApiPath: entry.adminApiPath,
    active: entry.active,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function createStore() {
  return {
    serversById: new Map(),
    serverIdByName: new Map(),
    configsByServerId: new Map(),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function makeServerEntry(input) {
  const now = nowIso();
  return {
    id: randomUUID(),
    name: String(input.name || "local-caddy"),
    apiUrl: String(input.apiUrl || "http://127.0.0.1"),
    apiPort: Number(input.apiPort || 2019),
    adminApiPath: String(input.adminApiPath || "/config/"),
    active: input.active !== false,
    createdAt: now,
    updatedAt: now,
  };
}

async function fetchCurrentConfig(server) {
  const base = new URL(server.apiUrl);
  const normalizedPath = server.adminApiPath.startsWith("/")
    ? server.adminApiPath
    : `/${server.adminApiPath}`;
  const adminUrl = `${base.protocol}//${base.hostname}:${server.apiPort}${normalizedPath}`;
  const response = await fetch(adminUrl);
  if (!response.ok) {
    throw new Error(`Caddy admin request failed: ${response.status}`);
  }
  return response.text();
}

async function captureCurrentConfig(store, serverId, options = {}) {
  const server = store.serversById.get(serverId);
  if (!server) {
    throw new Error("Server not found");
  }

  const configText = await fetchCurrentConfig(server);
  const parsed = (() => {
    try {
      return JSON.parse(configText);
    } catch {
      return configText;
    }
  })();

  const list = store.configsByServerId.get(serverId) || [];
  const record = {
    id: randomUUID(),
    name: String(options.name || `${server.name}-snapshot`),
    description: String(options.description || "Captured from Caddy admin API"),
    setAsActive: options.setAsActive === true,
    config: parsed,
    createdAt: nowIso(),
  };
  list.push(record);
  store.configsByServerId.set(serverId, list);
  server.updatedAt = nowIso();
  return record;
}

async function ensureBootstrapServer(store, env) {
  if (store.serverIdByName.has(env.targetServerName)) return;
  const entry = makeServerEntry({
    name: env.targetServerName,
    apiUrl: env.targetApiUrl,
    apiPort: env.targetApiPort,
    adminApiPath: env.targetAdminApiPath,
    active: true,
  });
  store.serversById.set(entry.id, entry);
  store.serverIdByName.set(entry.name, entry.id);
  try {
    await captureCurrentConfig(store, entry.id, {
      name: `${entry.name}-initial`,
      description: "Auto bootstrap",
      setAsActive: true,
    });
    process.stdout.write(`caddymanager-lite bootstrap ok: server=${entry.name} id=${entry.id}\n`);
  } catch (error) {
    process.stdout.write(
      `caddymanager-lite bootstrap skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function createUi(store) {
  const serverCount = store.serversById.size;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Caddy Manager</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #111; }
      code { background: #f4f4f5; padding: 0.15rem 0.3rem; border-radius: 4px; }
      .card { border: 1px solid #e4e4e7; border-radius: 8px; padding: 1rem; max-width: 52rem; }
      h1 { margin: 0 0 0.75rem 0; font-size: 1.4rem; }
      p { margin: 0.35rem 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Caddy Manager (Lite)</h1>
      <p>Servers: <strong>${serverCount}</strong></p>
      <p>Health: <code>/healthz</code></p>
      <p>API: <code>/api/v1/caddy/servers</code></p>
    </div>
  </body>
</html>`;
}

async function main() {
  const env = getEnv();
  const store = createStore();
  await ensureBootstrapServer(store, env);

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const { url, parts } = splitPath(req.url || "/");

    if (method === "GET" && url.pathname === "/healthz") {
      toJson(res, 200, { ok: true, servers: store.serversById.size });
      return;
    }

    if (method === "GET" && url.pathname === "/config") {
      toJson(res, 200, {
        api_base_url: "/api/v1",
        app_name: "Caddy Manager",
        enable_dark_mode: "true",
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/auth/login") {
      toJson(res, 200, { token });
      return;
    }

    if (
      parts.length === 4 &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "caddy" &&
      parts[3] === "servers"
    ) {
      if (method === "GET") {
        const data = Array.from(store.serversById.values()).map(toServerResponseShape);
        toJson(res, 200, { count: data.length, data });
        return;
      }

      if (method === "POST") {
        const body = await readJson(req);
        const entry = makeServerEntry(body);
        store.serversById.set(entry.id, entry);
        store.serverIdByName.set(entry.name, entry.id);
        if (body.pullExistingConfig === true) {
          try {
            await captureCurrentConfig(store, entry.id, {
              name: `${entry.name}-initial`,
              description: "Auto bootstrap",
              setAsActive: true,
            });
          } catch {
            // Keep the server even if snapshot fails.
          }
        }
        toJson(res, 201, { data: toServerResponseShape(entry) });
        return;
      }
    }

    if (
      parts.length === 6 &&
      parts[0] === "api" &&
      parts[1] === "v1" &&
      parts[2] === "caddy" &&
      parts[3] === "servers"
    ) {
      const serverId = parts[4];
      const action = parts[5];
      if (!store.serversById.has(serverId)) {
        toJson(res, 404, { error: "Server not found" });
        return;
      }

      if (method === "GET" && action === "configs") {
        const data = store.configsByServerId.get(serverId) || [];
        toJson(res, 200, { count: data.length, data });
        return;
      }

      if (method === "GET" && action === "current-config") {
        try {
          const record = await captureCurrentConfig(store, serverId, {
            name: url.searchParams.get("name") || undefined,
            description: url.searchParams.get("description") || undefined,
            setAsActive: url.searchParams.get("setAsActive") === "true",
          });
          toJson(res, 200, { data: record });
          return;
        } catch (error) {
          toJson(res, 502, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
    }

    if (method === "GET" && url.pathname === "/") {
      toHtml(res, 200, createUi(store));
      return;
    }

    toJson(res, 404, { error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.port, env.host, resolve);
  });

  process.stdout.write(`caddymanager-lite listening on http://${env.host}:${env.port}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `caddymanager-lite fatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
