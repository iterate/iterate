import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, resolve } from "node:path";
import { URL } from "node:url";
import { createClient, type ResultSet } from "@libsql/client";

const DEFAULT_SQLITE_PATHS = [
  "/var/lib/jonasland5/events-service.sqlite",
  "/var/lib/jonasland5/orders-service.sqlite",
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
    process.env.OUTERBASE_STUDIO_NAME ?? "jonasland5 sqlite",
  );
}
const studioOrigin = studioIframeUrl.origin;
const studioSrc = studioIframeUrl.toString();

const configuredMainPath = process.env.OUTERBASE_SQLITE_MAIN_PATH?.trim();
const sqliteSpecs = parseSqliteSpecs(process.env.OUTERBASE_SQLITE_PATHS ?? DEFAULT_SQLITE_PATHS);
if (!configuredMainPath && sqliteSpecs.length === 0) {
  throw new Error("No sqlite database configured. Set OUTERBASE_SQLITE_PATHS.");
}

const sqliteTargets = buildSqliteTargets(sqliteSpecs, configuredMainPath);
if (sqliteTargets.length === 0) {
  throw new Error("No sqlite database configured. Set OUTERBASE_SQLITE_PATHS.");
}

await Promise.all(
  sqliteTargets.map(async (target) => mkdir(dirname(target.path), { recursive: true })),
);

const sqliteTargetsByAlias = new Map(
  sqliteTargets.map((target) => [target.alias, target] as const),
);
const defaultMainAlias = resolveDefaultMainAlias(sqliteTargets, configuredMainPath);
const sqliteSessionByMainAlias = new Map<string, Promise<SqliteSession>>();

const server = createServer(async (req, res) => {
  if (!authorize(req, res)) return;

  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname;
  const mainAlias = resolveMainAlias(requestUrl.searchParams.get("main") ?? undefined);

  if (req.method === "GET" && pathname === "/healthz") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/runtime") {
    const session = await getSqliteSession(mainAlias);
    return json(res, 200, {
      studioSrc,
      selectedMainAlias: mainAlias,
      databases: sqliteTargets,
      mainPath: session.main.path,
      attached: session.attached,
    });
  }

  if (req.method === "POST" && pathname === "/query") {
    try {
      const body = await readJsonBody(req);
      const response = await executeRequest(body, mainAlias);
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
    return html(res, 200, buildPageHtml(mainAlias));
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

type SqliteTarget = {
  alias: string;
  path: string;
};

type SqliteSession = {
  client: ReturnType<typeof createClient>;
  main: SqliteTarget;
  attached: Record<string, string>;
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

function buildSqliteTargets(specs: SqliteSpec[], mainPath?: string): SqliteTarget[] {
  const usedAliases = new Set<string>(["main", "temp"]);
  const seenPaths = new Set<string>();
  const targets: SqliteTarget[] = [];

  const entries: SqliteSpec[] = [];
  if (mainPath) {
    entries.push({
      alias: process.env.OUTERBASE_SQLITE_MAIN_ALIAS?.trim(),
      path: mainPath,
    });
  }
  entries.push(...specs);

  for (const spec of entries) {
    const resolvedPath = resolve(spec.path);
    if (seenPaths.has(resolvedPath)) continue;
    seenPaths.add(resolvedPath);

    const preferredAlias = spec.alias ?? deriveAliasFromPath(resolvedPath);
    const alias = claimAlias(preferredAlias, usedAliases);
    targets.push({
      alias,
      path: resolvedPath,
    });
  }

  return targets;
}

function resolveDefaultMainAlias(targets: SqliteTarget[], mainPath?: string): string {
  if (targets.length === 0) {
    throw new Error("No sqlite targets configured.");
  }

  if (mainPath) {
    const resolvedMainPath = resolve(mainPath);
    const found = targets.find((target) => target.path === resolvedMainPath);
    if (found) return found.alias;
  }

  return targets[0].alias;
}

function resolveMainAlias(alias: string | undefined): string {
  if (alias && sqliteTargetsByAlias.has(alias)) return alias;
  return defaultMainAlias;
}

function buildAttachedMap(mainAlias: string): Record<string, string> {
  const attached: Record<string, string> = {};

  for (const target of sqliteTargets) {
    if (target.alias === mainAlias) continue;
    attached[target.alias] = target.path;
  }

  return attached;
}

async function createSqliteSession(mainAlias: string): Promise<SqliteSession> {
  const main = sqliteTargetsByAlias.get(mainAlias);
  if (!main) {
    throw new Error(`Unknown sqlite main alias: ${mainAlias}`);
  }

  const attached = buildAttachedMap(mainAlias);
  const client = createClient({ url: `file:${main.path}` });

  for (const [alias, filePath] of Object.entries(attached)) {
    await client.execute(
      `ATTACH DATABASE ${escapeSqlString(filePath)} AS ${escapeSqlIdentifier(alias)}`,
    );
  }

  return {
    client,
    main,
    attached,
  };
}

function getSqliteSession(mainAlias: string): Promise<SqliteSession> {
  const cached = sqliteSessionByMainAlias.get(mainAlias);
  if (cached) return cached;

  const promise = createSqliteSession(mainAlias).catch((error) => {
    sqliteSessionByMainAlias.delete(mainAlias);
    throw error;
  });

  sqliteSessionByMainAlias.set(mainAlias, promise);
  return promise;
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

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteMainAliasQualifier(statement: string, mainAlias: string): string {
  if (!mainAlias || mainAlias === "main") return statement;

  const escapedAlias = escapeRegExp(mainAlias);
  const bareAlias = new RegExp(`\\b${escapedAlias}\\s*\\.`, "g");
  const quotedAlias = new RegExp(`"${escapedAlias}"\\s*\\.`, "g");
  const backtickAlias = new RegExp(`\`${escapedAlias}\`\\s*\\.`, "g");
  const bracketAlias = new RegExp(`\\[${escapedAlias}\\]\\s*\\.`, "g");

  return statement
    .replaceAll(quotedAlias, "main.")
    .replaceAll(backtickAlias, "main.")
    .replaceAll(bracketAlias, "main.")
    .replaceAll(bareAlias, "main.");
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
  const headers = raw.columns.map((displayName: string, index: number) => {
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
    headers.reduce<Record<string, unknown>>((acc, header: (typeof headers)[number], index) => {
      const value = (row as ArrayLike<unknown>)[index];
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

async function executeRequest(value: unknown, mainAlias: string): Promise<QueryResponse> {
  if (!value || typeof value !== "object") {
    return { type: "query", id: -1, error: "invalid_request" };
  }

  const session = await getSqliteSession(mainAlias);
  const request = value as Partial<QueryRequest>;
  const id = typeof request.id === "number" ? request.id : -1;
  const type = request.type;

  if (type === "query") {
    if (typeof request.statement !== "string") {
      return { type, id, error: "invalid_statement" };
    }
    try {
      const result = await session.client.execute(
        rewriteMainAliasQualifier(request.statement, session.main.alias),
      );
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
      const rewrittenStatements = request.statements.map((statement) =>
        rewriteMainAliasQualifier(statement, session.main.alias),
      );
      const results = await session.client.batch(rewrittenStatements, "write");
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

function buildPageHtml(mainAlias: string): string {
  const selectedMain =
    sqliteTargetsByAlias.get(mainAlias) ?? sqliteTargetsByAlias.get(defaultMainAlias);
  if (!selectedMain) {
    throw new Error("No sqlite main target configured.");
  }

  const attached = buildAttachedMap(selectedMain.alias);
  const studioOriginJson = JSON.stringify(studioOrigin);
  const defaultMainAliasJson = JSON.stringify(defaultMainAlias);
  const allowedStudioOriginsJson = JSON.stringify(
    Array.from(new Set([studioOrigin, "https://studio.outerbase.com", "https://libsqlstudio.com"])),
  );
  const summaryJson = JSON.stringify({
    mainAlias: selectedMain.alias,
    mainPath: selectedMain.path,
    attached,
    databases: sqliteTargets,
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
        height: 100vh;
        overflow: hidden;
        background: #020617;
        color: #e2e8f0;
      }
      .layout {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      .topbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.25);
        background: #0b1220;
      }
      .topbar label {
        color: #cbd5e1;
        font-size: 12px;
        font-weight: 600;
      }
      .topbar select {
        color: #e2e8f0;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
      }
      .topbar .main-picker {
        min-width: min(52vw, 560px);
        max-width: min(72vw, 860px);
      }
      .topbar button {
        color: #e2e8f0;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .topbar button:hover {
        background: #162033;
      }
      .topbar button .caret {
        display: inline-block;
        margin-left: 4px;
        color: #94a3b8;
        transition: transform 120ms ease;
      }
      .topbar button.is-open .caret {
        transform: rotate(180deg);
      }
      .help-panel code,
      .help-panel pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      .help-panel {
        display: block;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
        background: #0b1325;
        color: #cbd5e1;
        font-size: 12px;
      }
      .help-panel[hidden] {
        display: none;
      }
      .help-grid {
        display: grid;
        grid-template-columns: minmax(240px, 1fr) minmax(320px, 1.5fr);
        gap: 14px;
      }
      .help-section-title {
        margin: 0 0 8px 0;
        font-size: 12px;
        font-weight: 700;
        color: #e2e8f0;
      }
      .help-db-list {
        margin: 0;
        padding-left: 16px;
      }
      .help-db-list li {
        margin: 0 0 6px 0;
        word-break: break-word;
      }
      .help-copy {
        margin: 0;
        color: #cbd5e1;
        line-height: 1.4;
      }
      .help-panel pre {
        margin: 8px 0 0 0;
        padding: 8px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 6px;
        background: #020617;
        overflow: auto;
      }
      @media (max-width: 780px) {
        .help-grid {
          grid-template-columns: 1fr;
        }
      }
      .frame {
        border: 0;
        width: 100%;
        flex: 1;
        min-height: 0;
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <div class="topbar">
        <label for="main-picker">Main DB</label>
        <select id="main-picker" class="main-picker"></select>
        <button id="info-toggle" type="button" aria-controls="help-panel" aria-expanded="false">
          Info<span class="caret" aria-hidden="true">▾</span>
        </button>
      </div>
      <div class="help-panel" id="help-panel" hidden></div>
      <iframe id="editor" class="frame"></iframe>
    </div>
    <script>
      const iframe = document.getElementById("editor");
      const mainPicker = document.getElementById("main-picker");
      const infoToggle = document.getElementById("info-toggle");
      const helpPanel = document.getElementById("help-panel");
      const studioSrc = ${JSON.stringify(studioSrc)};
      const studioOrigin = ${studioOriginJson};
      const defaultMainAlias = ${defaultMainAliasJson};
      const allowedStudioOrigins = ${allowedStudioOriginsJson};
      const summary = ${summaryJson};
      const queryPath = "/query?main=" + encodeURIComponent(summary.mainAlias);

      for (const database of summary.databases) {
        const option = document.createElement("option");
        option.value = database.alias;
        option.textContent = database.alias + " - " + database.path;
        mainPicker.appendChild(option);
      }

      mainPicker.value = summary.mainAlias;
      mainPicker.addEventListener("change", () => {
        const nextAlias = mainPicker.value;
        const url = new URL(window.location.href);

        if (nextAlias === defaultMainAlias) {
          url.searchParams.delete("main");
        } else {
          url.searchParams.set("main", nextAlias);
        }

        window.location.assign(url.toString());
      });

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      const connectedDatabases = [{ name: "main", path: summary.mainPath }].concat(
        summary.databases.map((database) => ({ name: database.alias, path: database.path })),
      );
      const connectedRows = connectedDatabases
        .map((database) => "<li><code>" + escapeHtml(database.name) + "</code> -> <code>" + escapeHtml(database.path) + "</code></li>")
        .join("");
      const helpQueryExamples = [
        "-- 1) Latest orders joined to events",
        "SELECT o.id AS order_id, o.status, o.sku, e.type AS event_type, o.created_at",
        "FROM orders_service.orders o",
        "LEFT JOIN events_service.events e ON e.id = o.event_id",
        "ORDER BY o.created_at DESC",
        "LIMIT 20;",
        "",
        "-- 2) Count orders by status + event type",
        "SELECT COALESCE(e.type, '<no_event>') AS event_type, o.status, COUNT(*) AS order_count",
        "FROM orders_service.orders o",
        "LEFT JOIN events_service.events e ON e.id = o.event_id",
        "GROUP BY COALESCE(e.type, '<no_event>'), o.status",
        "ORDER BY order_count DESC, event_type ASC, o.status ASC",
        "LIMIT 50;",
        "",
        "-- 3) Events with no matching order",
        "SELECT e.id AS event_id, e.type, e.created_at",
        "FROM events_service.events e",
        "LEFT JOIN orders_service.orders o ON o.event_id = e.id",
        "WHERE o.id IS NULL",
        "ORDER BY e.created_at DESC",
        "LIMIT 20;",
      ].join("\\n");
      helpPanel.innerHTML =
        "<div class='help-grid'>" +
          "<section>" +
            "<h3 class='help-section-title'>Connected databases</h3>" +
            "<ul class='help-db-list'>" + connectedRows + "</ul>" +
          "</section>" +
          "<section>" +
            "<h3 class='help-section-title'>How to query</h3>" +
            "<p class='help-copy'>Copy any query block below. Use explicit aliases <code>events_service</code> and <code>orders_service</code> so it runs no matter which DB is selected as <code>main</code>.</p>" +
            "<pre>" + helpQueryExamples + "</pre>" +
          "</section>" +
        "</div>";

      infoToggle.addEventListener("click", () => {
        helpPanel.hidden = !helpPanel.hidden;
        infoToggle.classList.toggle("is-open", !helpPanel.hidden);
        infoToggle.setAttribute("aria-expanded", String(!helpPanel.hidden));
      });

      async function relay(message, targetOrigin) {
        const response = await fetch(queryPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        const payload = await response.json();
        iframe.contentWindow.postMessage(payload, targetOrigin);
      }

      window.addEventListener("message", (event) => {
        if (!allowedStudioOrigins.includes(event.origin)) return;
        const data = event.data;
        if (!data || (data.type !== "query" && data.type !== "transaction")) return;
        relay(data, event.origin).catch((error) => {
          iframe.contentWindow.postMessage(
            {
              type: data.type,
              id: data.id,
              error: error && error.message ? error.message : String(error),
            },
            event.origin,
          );
        });
      });

      iframe.src = studioSrc;
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
