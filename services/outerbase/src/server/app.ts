import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import type { ServiceAppEnv } from "@iterate-com/shared/jonasland";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceObservabilityHandler,
  createServiceOpenAPIHandler,
  createSimpleServiceRouter,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  transformLibsqlResultSet,
} from "@iterate-com/shared/jonasland";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono, type Context } from "hono";

const serviceName = "jonasland-outerbase-service";
const serviceVersion = "0.0.1";
const DEFAULT_SQLITE_PATHS = [
  "/var/lib/jonasland/events-service.sqlite",
  "/var/lib/jonasland/example.sqlite",
].join(",");

let studioOrigin = "";
let studioSrc = "";
let sqliteTargets: SqliteTarget[] = [];
let sqliteTargetsByAlias = new Map<string, SqliteTarget>();
let defaultMainAlias = "main";
const sqliteSessionByMainAlias = new Map<string, Promise<SqliteSession>>();

type SqliteSpec = {
  alias?: string;
  path: string;
};

type SqliteTarget = {
  alias: string;
  path: string;
};

type SqliteSession = {
  client: ReturnType<typeof drizzle>["$client"];
  main: SqliteTarget;
  attached: Record<string, string>;
};

type SqlResultSet = {
  columns: string[];
  columnTypes: Array<string | null>;
  rows: unknown[][];
  rowsAffected?: number;
  lastInsertRowid?: number | bigint | null;
};

type QueryRequest =
  | { type: "query"; id: number; statement: string }
  | { type: "transaction"; id: number; statements: string[] };

type QueryResponse =
  | { type: "query"; id: number; data: QueryResult; error?: string }
  | { type: "transaction"; id: number; data: QueryResult[]; error?: string }
  | { type: "query" | "transaction"; id: number; error: string };

type QueryResult = ReturnType<typeof transformLibsqlResultSet>;

type OuterbaseEnv = {
  host: string;
  port: number;
  mainPath?: string;
  sqlitePaths: string;
  sqliteMainAlias?: string;
  basicAuthUser?: string;
  basicAuthPass: string;
  studioEmbedUrl: string;
  studioName: string;
};

type AppEnv = { Bindings: HttpBindings };

function parsePort(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key}: ${value}`);
  }
  return parsed;
}

function getEnv(): OuterbaseEnv {
  const rawHost = process.env.OUTERBASE_SERVICE_HOST?.trim();
  return {
    host: rawHost && rawHost.length > 0 ? rawHost : "0.0.0.0",
    port: parsePort(
      process.env.OUTERBASE_SERVICE_PORT ?? process.env.PORT ?? "19080",
      "OUTERBASE_SERVICE_PORT",
    ),
    mainPath: process.env.OUTERBASE_SQLITE_MAIN_PATH?.trim(),
    sqlitePaths: process.env.OUTERBASE_SQLITE_PATHS ?? DEFAULT_SQLITE_PATHS,
    sqliteMainAlias: process.env.OUTERBASE_SQLITE_MAIN_ALIAS?.trim(),
    basicAuthUser: process.env.OUTERBASE_BASIC_AUTH_USER?.trim(),
    basicAuthPass: process.env.OUTERBASE_BASIC_AUTH_PASS ?? "",
    studioEmbedUrl:
      process.env.OUTERBASE_STUDIO_EMBED_URL ?? "https://studio.outerbase.com/embed/sqlite",
    studioName: process.env.OUTERBASE_STUDIO_NAME ?? "jonasland sqlite",
  };
}

async function initializeRuntime(env: OuterbaseEnv): Promise<void> {
  const studioIframeUrl = new URL(env.studioEmbedUrl);
  if (!studioIframeUrl.searchParams.has("name")) {
    studioIframeUrl.searchParams.set("name", env.studioName);
  }
  studioOrigin = studioIframeUrl.origin;
  studioSrc = studioIframeUrl.toString();

  const sqliteSpecs = parseSqliteSpecs(env.sqlitePaths);
  if (!env.mainPath && sqliteSpecs.length === 0) {
    throw new Error("No sqlite database configured. Set OUTERBASE_SQLITE_PATHS.");
  }

  const nextTargets = buildSqliteTargets(sqliteSpecs, env.mainPath, env.sqliteMainAlias);
  if (nextTargets.length === 0) {
    throw new Error("No sqlite database configured. Set OUTERBASE_SQLITE_PATHS.");
  }

  await Promise.all(
    nextTargets.map(async (target) => mkdir(dirname(target.path), { recursive: true })),
  );

  sqliteTargets = nextTargets;
  sqliteTargetsByAlias = new Map(nextTargets.map((target) => [target.alias, target] as const));
  defaultMainAlias = resolveDefaultMainAlias(nextTargets, env.mainPath);
  sqliteSessionByMainAlias.clear();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

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

function buildSqliteTargets(
  specs: SqliteSpec[],
  mainPath?: string,
  mainAlias?: string,
): SqliteTarget[] {
  const usedAliases = new Set<string>(["main", "temp"]);
  const seenPaths = new Set<string>();
  const targets: SqliteTarget[] = [];

  const entries: SqliteSpec[] = [];
  if (mainPath) {
    entries.push({
      alias: mainAlias,
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
  const client = drizzle(main.path).$client;
  client.pragma("journal_mode = WAL");

  for (const [alias, filePath] of Object.entries(attached)) {
    client.exec(`ATTACH DATABASE ${escapeSqlString(filePath)} AS ${escapeSqlIdentifier(alias)}`);
    client.exec(`PRAGMA ${alias}.journal_mode = WAL`);
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

function executeSqlStatement(
  client: ReturnType<typeof drizzle>["$client"],
  statement: string,
): SqlResultSet {
  const prepared = client.prepare(statement);
  if (prepared.reader) {
    const headers = prepared.columns() as Array<{
      name: string;
      type?: string | null;
    }>;
    const rows = prepared.raw().all() as unknown[][];
    return {
      columns: headers.map((header) => header.name),
      columnTypes: headers.map((header) => header.type ?? null),
      rows,
      rowsAffected: rows.length,
    };
  }

  const runResult = prepared.run();
  return {
    columns: [],
    columnTypes: [],
    rows: [],
    rowsAffected: runResult.changes,
    lastInsertRowid: runResult.lastInsertRowid,
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
      const result = executeSqlStatement(
        session.client,
        rewriteMainAliasQualifier(request.statement, session.main.alias),
      );
      return { type, id, data: transformLibsqlResultSet(result) };
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
      session.client.exec("BEGIN");
      const results: SqlResultSet[] = [];
      try {
        for (const statement of rewrittenStatements) {
          results.push(executeSqlStatement(session.client, statement));
        }
        session.client.exec("COMMIT");
      } catch (error) {
        session.client.exec("ROLLBACK");
        throw error;
      }
      return { type, id, data: results.map(transformLibsqlResultSet) };
    } catch (error) {
      return { type, id, error: String((error as Error).message ?? error) };
    }
  }

  return { type: "query", id, error: "unsupported_type" };
}

function createAuthorizeMiddleware(env: OuterbaseEnv) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const username = env.basicAuthUser;
    const password = env.basicAuthPass;
    if (!username) return next();

    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Basic ")) {
      c.header("WWW-Authenticate", 'Basic realm="outerbase"');
      return c.text("Unauthorized", 401);
    }

    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const expected = `${username}:${password}`;
    if (decoded !== expected) {
      c.header("WWW-Authenticate", 'Basic realm="outerbase"');
      return c.text("Unauthorized", 401);
    }

    return next();
  };
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
        "-- 1) Latest example things joined to events",
        "SELECT t.id AS thing_id, t.thing, e.type AS event_type, t.created_at",
        "FROM example.things t",
        "LEFT JOIN events_service.events e ON e.id = t.event_id",
        "ORDER BY t.created_at DESC",
        "LIMIT 20;",
        "",
        "-- 2) Count things by event type",
        "SELECT COALESCE(e.type, '<no_event>') AS event_type, COUNT(*) AS thing_count",
        "FROM example.things t",
        "LEFT JOIN events_service.events e ON e.id = t.event_id",
        "GROUP BY COALESCE(e.type, '<no_event>')",
        "ORDER BY thing_count DESC, event_type ASC",
        "LIMIT 50;",
        "",
        "-- 3) Events with no matching thing",
        "SELECT e.id AS event_id, e.type, e.created_at",
        "FROM events_service.events e",
        "LEFT JOIN example.things t ON t.event_id = e.id",
        "WHERE t.id IS NULL",
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
            "<p class='help-copy'>Copy any query block below. Use explicit aliases <code>events_service</code> and <code>example</code> so it runs no matter which DB is selected as <code>main</code>.</p>" +
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

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const outerbaseEnv = getEnv();
await initializeRuntime(outerbaseEnv);

const executeSql = async (statement: string) => {
  const session = await getSqliteSession(defaultMainAlias);
  return executeSqlStatement(session.client, statement);
};

const outerbaseRouter = createSimpleServiceRouter({
  serviceName,
  version: serviceVersion,
  executeSql,
});

const openAPIHandler = createServiceOpenAPIHandler({
  router: outerbaseRouter,
  title: "jonasland outerbase API",
  version: serviceVersion,
});

const app = new Hono<ServiceAppEnv>();
const { injectWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);
app.use("*", createAuthorizeMiddleware(outerbaseEnv));

const resolveOuterbaseRuntimeConfig = async () => ({
  mainAlias: defaultMainAlias,
  targets: sqliteTargets,
});

app.get("/api/observability", createServiceObservabilityHandler(resolveOuterbaseRuntimeConfig));

app.get("/api/runtime", async (c: Context<AppEnv>) => {
  const mainAlias = resolveMainAlias(c.req.query("main"));
  const session = await getSqliteSession(mainAlias);
  return c.json({
    studioSrc,
    selectedMainAlias: mainAlias,
    databases: sqliteTargets,
    mainPath: session.main.path,
    attached: session.attached,
  });
});

app.post("/query", async (c: Context<AppEnv>) => {
  const mainAlias = resolveMainAlias(c.req.query("main"));
  try {
    const body = await c.req.json();
    const response = await executeRequest(body, mainAlias);
    return c.json(response);
  } catch (error) {
    return c.json(
      {
        type: "query",
        id: -1,
        error: String((error as Error).message ?? error),
      },
      400,
    );
  }
});

app.get("/api/studio", async (c: Context<AppEnv>) => {
  const mainAlias = resolveMainAlias(c.req.query("main"));
  return c.html(buildPageHtml(mainAlias));
});

applyOpenAPIRoute(app, openAPIHandler, serviceName);

app.onError((error: Error, c: Context<AppEnv>) => {
  c.get("requestLog").error(toError(error));
  return c.json({ error: "internal_error" }, 500);
});

app.notFound((c: Context<AppEnv>) => c.json({ error: "not_found" }, 404));

export default app;
export { injectWebSocket };
