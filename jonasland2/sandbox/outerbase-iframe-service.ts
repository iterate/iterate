import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, resolve } from "node:path";
import { URL } from "node:url";
import { createClient, type ResultSet } from "@libsql/client";

const DEFAULT_SQLITE_PATHS = [
  "/var/lib/jonasland2/events-service.sqlite",
  "/var/lib/jonasland2/orders-service.sqlite",
].join(",");

const rawPort = process.env.OUTERBASE_SERVICE_PORT ?? process.env.PORT ?? "19040";
const port = Number.parseInt(rawPort, 10);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid OUTERBASE_SERVICE_PORT: ${rawPort}`);
}

const studioIframeUrl = new URL(
  process.env.OUTERBASE_STUDIO_EMBED_URL ?? "https://studio.outerbase.com/embed/sqlite",
);
if (!studioIframeUrl.searchParams.has("name")) {
  studioIframeUrl.searchParams.set(
    "name",
    process.env.OUTERBASE_STUDIO_NAME ?? "jonasland2 sqlite",
  );
}
const studioOrigin = studioIframeUrl.origin;
const studioSrc = studioIframeUrl.toString();

const configuredMainPath = process.env.OUTERBASE_SQLITE_MAIN_PATH?.trim();
const sqliteSpecs = parseSqliteSpecs(process.env.OUTERBASE_SQLITE_PATHS ?? DEFAULT_SQLITE_PATHS);
if (!configuredMainPath && sqliteSpecs.length === 0) {
  throw new Error("No sqlite database configured. Set OUTERBASE_SQLITE_PATHS.");
}

const mainPath = resolve(configuredMainPath ?? sqliteSpecs[0].path);
const attachMap = buildAttachMap(sqliteSpecs, mainPath);

await mkdir(dirname(mainPath), { recursive: true });
await Promise.all(
  Object.values(attachMap).map(async (filePath) => mkdir(dirname(filePath), { recursive: true })),
);

const client = createClient({ url: `file:${mainPath}` });
for (const [alias, filePath] of Object.entries(attachMap)) {
  await client.execute(
    `ATTACH DATABASE ${escapeSqlString(filePath)} AS ${escapeSqlIdentifier(alias)}`,
  );
}

const server = createServer(async (req, res) => {
  if (!authorize(req, res)) return;

  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/runtime") {
    return json(res, 200, {
      studioSrc,
      mainPath,
      attached: attachMap,
    });
  }

  if (req.method === "POST" && pathname === "/query") {
    try {
      const body = await readJsonBody(req);
      const response = await executeRequest(body);
      return json(res, 200, response);
    } catch (error) {
      return json(res, 400, {
        type: "query",
        id: -1,
        error: String((error as Error).message ?? error),
      });
    }
  }

  if (req.method === "GET" && pathname === "/") {
    return html(res, 200, buildPageHtml());
  }

  return json(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0");

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

type SqliteSpec = {
  alias?: string;
  path: string;
};

type QueryRequest =
  | { type: "query"; id: number; statement: string }
  | { type: "transaction"; id: number; statements: string[] };

type QueryResponse =
  | { type: "query"; id: number; data: QueryResult; error?: string }
  | { type: "transaction"; id: number; data: QueryResult[]; error?: string }
  | { type: "query" | "transaction"; id: number; error: string };

type QueryResult = {
  rows: Record<string, unknown>[];
  headers: Array<{
    name: string;
    displayName: string;
    originalType: string | null;
    type: 1 | 2 | 3 | 4;
  }>;
  stat: {
    rowsAffected: number;
    rowsRead: number | null;
    rowsWritten: number | null;
    queryDurationMs: number | null;
  };
  lastInsertRowid?: number;
};

function parseSqliteSpecs(rawValue: string): SqliteSpec[] {
  return rawValue
    .split(/[,;\n]/g)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const eqIndex = value.indexOf("=");
      if (eqIndex > 0) {
        const alias = value.slice(0, eqIndex).trim();
        const path = value.slice(eqIndex + 1).trim();
        if (alias && path) return { alias, path };
      }
      return { path: value };
    });
}

function buildAttachMap(specs: SqliteSpec[], resolvedMainPath: string): Record<string, string> {
  const usedAliases = new Set<string>(["main", "temp"]);
  const attachedPaths = new Set<string>([resolvedMainPath]);
  const attach: Record<string, string> = {};

  for (const spec of specs) {
    const resolvedPath = resolve(spec.path);
    if (attachedPaths.has(resolvedPath)) continue;
    attachedPaths.add(resolvedPath);
    const preferredAlias = spec.alias ?? deriveAliasFromPath(resolvedPath);
    const alias = claimAlias(preferredAlias, usedAliases);
    attach[alias] = resolvedPath;
  }

  return attach;
}

function deriveAliasFromPath(filePath: string): string {
  const withoutExt = basename(filePath, extname(filePath));
  const normalized = withoutExt.replaceAll(/[^A-Za-z0-9_]/g, "_").replaceAll(/_+/g, "_");
  if (!normalized) return "db";
  if (/^[0-9]/.test(normalized)) return `db_${normalized}`;
  return normalized;
}

function claimAlias(preferredAlias: string, usedAliases: Set<string>): string {
  const baseAlias = deriveAliasFromPath(preferredAlias);
  if (!usedAliases.has(baseAlias)) {
    usedAliases.add(baseAlias);
    return baseAlias;
  }

  let nextAlias = baseAlias;
  let index = 1;
  while (usedAliases.has(nextAlias)) {
    nextAlias = `${baseAlias}_${index}`;
    index += 1;
  }
  usedAliases.add(nextAlias);
  return nextAlias;
}

function escapeSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function convertSqliteType(rawType: string | undefined | null): 1 | 2 | 3 | 4 {
  if (!rawType) return 4;
  const type = rawType.toUpperCase();
  if (
    type.includes("CHAR") ||
    type.includes("TEXT") ||
    type.includes("CLOB") ||
    type.includes("STRING")
  )
    return 1;
  if (type.includes("INT")) return 2;
  if (type.includes("REAL") || type.includes("DOUBLE") || type.includes("FLOAT")) return 3;
  if (type.includes("BLOB")) return 4;
  return 1;
}

function transformRawResult(raw: ResultSet): QueryResult {
  const headerNames = new Set<string>();
  const headers = raw.columns.map((displayName, index) => {
    const originalType = raw.columnTypes[index];
    let name = displayName;
    for (let i = 0; i < 20 && headerNames.has(name); i += 1) {
      name = `__${displayName}_${i}`;
    }
    headerNames.add(name);
    return {
      name,
      displayName,
      originalType: originalType ?? null,
      type: convertSqliteType(originalType),
    };
  });

  const rows = raw.rows.map((row) =>
    headers.reduce<Record<string, unknown>>((acc, header, index) => {
      const value = row[index];
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        acc[header.name] = Array.from(new Uint8Array(value));
      } else {
        acc[header.name] = value;
      }
      return acc;
    }, {}),
  );

  return {
    rows,
    headers,
    stat: {
      rowsAffected: raw.rowsAffected ?? 0,
      rowsRead: null,
      rowsWritten: null,
      queryDurationMs: 0,
    },
    lastInsertRowid:
      raw.lastInsertRowid === undefined || raw.lastInsertRowid === null
        ? undefined
        : Number(raw.lastInsertRowid),
  };
}

async function executeRequest(value: unknown): Promise<QueryResponse> {
  if (!value || typeof value !== "object") {
    return { type: "query", id: -1, error: "invalid_request" };
  }

  const request = value as Partial<QueryRequest>;
  const id = typeof request.id === "number" ? request.id : -1;
  const type = request.type;

  if (type === "query") {
    if (typeof request.statement !== "string") {
      return { type, id, error: "invalid_statement" };
    }
    try {
      const result = await client.execute(request.statement);
      return { type, id, data: transformRawResult(result) };
    } catch (error) {
      return { type, id, error: String((error as Error).message ?? error) };
    }
  }

  if (type === "transaction") {
    if (
      !Array.isArray(request.statements) ||
      !request.statements.every((statement) => typeof statement === "string")
    ) {
      return { type, id, error: "invalid_statements" };
    }
    try {
      const results = await client.batch(request.statements, "write");
      return { type, id, data: results.map(transformRawResult) };
    } catch (error) {
      return { type, id, error: String((error as Error).message ?? error) };
    }
  }

  return { type: "query", id, error: "unsupported_type" };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(part);
    totalSize += part.length;
    if (totalSize > 2_000_000) {
      throw new Error("Request body too large");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function authorize(req: IncomingMessage, res: ServerResponse): boolean {
  const username = process.env.OUTERBASE_BASIC_AUTH_USER?.trim();
  const password = process.env.OUTERBASE_BASIC_AUTH_PASS ?? "";
  if (!username) return true;

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Basic ")) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="outerbase"' });
    res.end("Unauthorized");
    return false;
  }

  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const expected = `${username}:${password}`;
  if (decoded !== expected) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="outerbase"' });
    res.end("Unauthorized");
    return false;
  }

  return true;
}

function buildPageHtml(): string {
  const studioSrcJson = JSON.stringify(studioSrc);
  const studioOriginJson = JSON.stringify(studioOrigin);
  const summaryJson = JSON.stringify({
    mainPath,
    attached: attachMap,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Outerbase Studio</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: #020617;
        color: #e2e8f0;
      }
      .frame {
        border: 0;
        width: 100vw;
        height: 100vh;
      }
      .meta {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 6px 10px;
        font-size: 12px;
        color: #94a3b8;
        background: rgba(2, 6, 23, 0.8);
        border-top: 1px solid rgba(148, 163, 184, 0.15);
        z-index: 2;
        backdrop-filter: blur(8px);
      }
      .meta code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
    </style>
  </head>
  <body>
    <iframe id="editor" class="frame" src=${JSON.stringify(studioSrc)}></iframe>
    <div class="meta" id="meta"></div>
    <script>
      const iframe = document.getElementById("editor");
      const studioSrc = ${studioSrcJson};
      const studioOrigin = ${studioOriginJson};
      const summary = ${summaryJson};

      const attached = Object.keys(summary.attached);
      document.getElementById("meta").innerHTML =
        "main: <code>" + summary.mainPath + "</code>" +
        (attached.length === 0
          ? ""
          : " · attach: <code>" + attached.map((key) => key + "=" + summary.attached[key]).join(", ") + "</code>");

      async function relay(message) {
        const response = await fetch("/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        const payload = await response.json();
        iframe.contentWindow.postMessage(payload, studioOrigin);
      }

      window.addEventListener("message", (event) => {
        if (event.origin !== studioOrigin) return;
        const data = event.data;
        if (!data || (data.type !== "query" && data.type !== "transaction")) return;
        relay(data).catch((error) => {
          iframe.contentWindow.postMessage(
            {
              type: data.type,
              id: data.id,
              error: error && error.message ? error.message : String(error),
            },
            studioOrigin,
          );
        });
      });
    </script>
  </body>
</html>`;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function html(res: ServerResponse, statusCode: number, value: string): void {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(value);
}
