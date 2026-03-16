import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ServiceAppEnv } from "@iterate-com/shared/jonasland";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  registryContract,
  registryServiceEnvSchema,
  registryServiceManifest,
} from "@iterate-com/registry-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceOpenAPIHandler,
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  infoFromContext,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  transformLibsqlResultSet,
  transformSqlResultSet,
  type ServiceRequestLogger,
  type SqlResultSet,
} from "@iterate-com/shared/jonasland";
import { Hono, type Context } from "hono";
import { ORPCError, implement } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { reconcileCaddyConfig } from "../caddy-sync.ts";
import { ServicesStore } from "../db.ts";
import { ResolvePublicUrlError, resolvePublicUrl } from "../resolve-public-url.ts";

type RegistryEnv = ReturnType<typeof registryServiceEnvSchema.parse>;
type PersistedRoute = Awaited<ReturnType<ServicesStore["listRoutes"]>>[number];

interface RegistryContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
  store: ServicesStore;
  env: RegistryEnv;
}

type SqliteRouteSource = {
  id: string;
  host: string;
  title: string;
  publicURL: string;
  sqlitePath: string;
  sqliteAlias: string;
  tags: string[];
  updatedAt: string;
};

type SqliteTarget = {
  alias: string;
  path: string;
  host?: string;
  title?: string;
};

type SqliteSession = {
  client: ReturnType<typeof drizzle>["$client"];
  main: SqliteTarget;
  attached: Record<string, string>;
};

type DbQueryRequest =
  | { type: "query"; id: number; statement: string }
  | { type: "transaction"; id: number; statements: string[] };

type DbQueryResponse =
  | { type: "query"; id: number; data: ReturnType<typeof transformLibsqlResultSet>; error?: string }
  | {
      type: "transaction";
      id: number;
      data: Array<ReturnType<typeof transformLibsqlResultSet>>;
      error?: string;
    }
  | { type: "query" | "transaction"; id: number; error: string };

const CADDY_CONFIG_DIR = "/home/iterate/.iterate/caddy";
const CADDY_ROOT_CADDYFILE = `${CADDY_CONFIG_DIR}/Caddyfile`;
const CADDY_BIN_PATH = "/usr/local/bin/caddy";
const CADDY_ADMIN_URL = "http://127.0.0.1:2019";
const CADDY_LISTEN_ADDRESS = ":80";

let storePromise: Promise<ServicesStore> | null = null;
let envCache: RegistryEnv | null = null;
let dbRuntimeSignature = "";
let studioOrigin = "";
let studioSrc = "";
let sqliteTargets: SqliteTarget[] = [];
let sqliteTargetsByAlias = new Map<string, SqliteTarget>();
let defaultMainAlias = "main";
const sqliteSessionByMainAlias = new Map<string, Promise<SqliteSession>>();

const registryRuntimeDefaults = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
} as const;

function applyRegistryRuntimeEnvDefaults() {
  for (const [key, value] of Object.entries(registryRuntimeDefaults)) {
    const current = process.env[key];
    if (current === undefined || current.trim().length === 0) {
      process.env[key] = value;
    }
  }
}

function getEnv() {
  envCache ??= registryServiceEnvSchema.parse(process.env);
  return envCache;
}

export async function ensureStore(): Promise<ServicesStore> {
  if (!storePromise) {
    storePromise = ServicesStore.open(getEnv().REGISTRY_DB_PATH);
  }
  return await storePromise;
}

const serviceName = "jonasland-registry-service";
const os = implement(registryContract).$context<RegistryContext>();
applyRegistryRuntimeEnvDefaults();
initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

function hasTag(route: PersistedRoute, tag: string): boolean {
  return route.tags.some((entry) => entry.toLowerCase() === tag.toLowerCase());
}

function normalizeOpenApiPath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function routeTitle(route: PersistedRoute): string {
  return route.metadata.title?.trim() || route.host;
}

function safePublicUrl(params: { env: RegistryEnv; internalURL: string }): string {
  try {
    return resolvePublicUrl({
      ITERATE_INGRESS_HOST: params.env.ITERATE_INGRESS_HOST,
      ITERATE_INGRESS_ROUTING_TYPE: params.env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_SERVICE: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
      internalURL: params.internalURL,
    });
  } catch {
    return params.internalURL;
  }
}

function serviceUrlForRoute(route: PersistedRoute, env: RegistryEnv): string {
  return safePublicUrl({
    env,
    internalURL: `http://${route.host}/`,
  });
}

function docsUrlForRoute(route: PersistedRoute, env: RegistryEnv): string | undefined {
  if (!hasTag(route, "openapi")) return undefined;
  return safePublicUrl({
    env,
    internalURL: `http://${route.host}/api/docs`,
  });
}

function listOpenApiSources(params: { routes: PersistedRoute[]; env: RegistryEnv }): Array<{
  id: string;
  title: string;
  specUrl: string;
  serviceUrl: string;
}> {
  return params.routes
    .filter((route) => hasTag(route, "openapi"))
    .map((route) => {
      const openApiPath = normalizeOpenApiPath(route.metadata.openapiPath);
      if (openApiPath.length === 0) return null;
      return {
        id: route.host,
        title: routeTitle(route),
        specUrl: safePublicUrl({
          env: params.env,
          internalURL: `http://${route.host}${openApiPath}`,
        }),
        serviceUrl: serviceUrlForRoute(route, params.env),
      };
    })
    .filter((source): source is NonNullable<typeof source> => source !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function listSqliteSources(params: {
  routes: PersistedRoute[];
  env: RegistryEnv;
}): SqliteRouteSource[] {
  return params.routes
    .filter((route) => hasTag(route, "sqlite"))
    .map((route) => {
      const sqlitePath = route.metadata.sqlitePath?.trim();
      if (!sqlitePath) return null;
      const sqliteAlias = route.metadata.sqliteAlias?.trim() || deriveAliasFromPath(sqlitePath);
      return {
        id: route.host,
        host: route.host,
        title: routeTitle(route),
        publicURL: serviceUrlForRoute(route, params.env),
        sqlitePath,
        sqliteAlias,
        tags: [...route.tags],
        updatedAt: route.updatedAt,
      };
    })
    .filter((source): source is SqliteRouteSource => source !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function buildLandingData(params: { routes: PersistedRoute[]; env: RegistryEnv }) {
  const docsSources = listOpenApiSources(params);
  const dbSources = listSqliteSources(params);
  return {
    ingress: {
      ITERATE_INGRESS_HOST: params.env.ITERATE_INGRESS_HOST ?? null,
      ITERATE_INGRESS_ROUTING_TYPE: params.env.ITERATE_INGRESS_ROUTING_TYPE,
      ITERATE_INGRESS_DEFAULT_SERVICE: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
    },
    routes: params.routes
      .map((route) => ({
        ...route,
        title: routeTitle(route),
        publicURL: serviceUrlForRoute(route, params.env),
        ...(docsUrlForRoute(route, params.env)
          ? { docsURL: docsUrlForRoute(route, params.env) }
          : {}),
        hasOpenAPI: hasTag(route, "openapi"),
        hasSqlite: hasTag(route, "sqlite"),
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    docsSources,
    dbSources,
  };
}

function buildLandingHtml(data: ReturnType<typeof buildLandingData>): string {
  const docsRows =
    data.docsSources.length === 0
      ? '<li class="empty">No OpenAPI sources discovered.</li>'
      : data.docsSources
          .map(
            (source) =>
              `<li class="item"><div class="item-title">${escapeHtml(source.title)}</div><a class="mono" href="${escapeHtml(source.serviceUrl)}">${escapeHtml(source.serviceUrl)}</a><a class="mono subtle" href="${escapeHtml(source.specUrl)}">${escapeHtml(source.specUrl)}</a></li>`,
          )
          .join("");
  const dbRows =
    data.dbSources.length === 0
      ? '<li class="empty">No sqlite databases discovered.</li>'
      : data.dbSources
          .map(
            (source) =>
              `<li class="item"><div class="item-title">${escapeHtml(source.title)}</div><div class="meta"><span class="tag">sqlite</span><span>${escapeHtml(source.sqliteAlias)}</span></div><div class="mono subtle">${escapeHtml(source.sqlitePath)}</div></li>`,
          )
          .join("");
  const routeRows =
    data.routes.length === 0
      ? '<li class="empty">No routes registered.</li>'
      : data.routes
          .map((route) => {
            const tags =
              route.tags.length === 0
                ? ""
                : `<div class="meta">${route.tags
                    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
                    .join("")}</div>`;
            const docsLine = route.docsURL
              ? `<a class="mono subtle" href="${escapeHtml(route.docsURL)}">${escapeHtml(route.docsURL)}</a>`
              : "";
            return `<li class="item"><div class="item-title">${escapeHtml(route.title)}</div>${tags}<a class="mono" href="${escapeHtml(route.publicURL)}">${escapeHtml(route.publicURL)}</a>${docsLine}<div class="mono subtle">${escapeHtml(route.target)}</div></li>`;
          })
          .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jonasland Registry</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: #f6f7fb;
        color: #111827;
      }
      main {
        margin: 0 auto;
        max-width: 80rem;
        padding: 2rem 1.25rem 3rem;
      }
      h1 {
        margin: 0;
        font-size: 2rem;
        line-height: 1.15;
      }
      p {
        margin: 0.5rem 0 0;
        color: #4b5563;
      }
      .hero {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.72rem 1rem;
        border-radius: 0.75rem;
        border: 1px solid #dbe0ea;
        background: #fff;
        color: #111827;
        text-decoration: none;
        font-weight: 600;
      }
      .columns {
        display: grid;
        gap: 1rem;
      }
      .card {
        border: 1px solid #e5e7eb;
        border-radius: 1rem;
        background: #fff;
        padding: 1rem;
      }
      .card h2 {
        margin: 0 0 0.75rem;
        font-size: 0.82rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6b7280;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .item,
      .empty {
        padding: 0.8rem 0;
        border-top: 1px solid #eef2f7;
      }
      .item:first-child,
      .empty:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .item-title {
        font-size: 1rem;
        font-weight: 650;
        margin-bottom: 0.35rem;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-bottom: 0.35rem;
      }
      .tag {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        background: #eff3ff;
        color: #334155;
        padding: 0.15rem 0.5rem;
        font-size: 0.75rem;
      }
      .mono {
        display: block;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.88rem;
        color: #111827;
        text-decoration: none;
        word-break: break-all;
      }
      .mono:hover {
        text-decoration: underline;
      }
      .subtle {
        margin-top: 0.25rem;
        color: #6b7280;
      }
      .summary {
        display: grid;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .summary-row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        font-size: 0.92rem;
      }
      @media (min-width: 960px) {
        .columns {
          grid-template-columns: 1.1fr 0.9fr 1.3fr;
          align-items: start;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="hero">
        <div>
          <h1>jonasland registry</h1>
          <p>One control-plane app for routes, docs, and sqlite discovery.</p>
        </div>
        <div class="actions">
          <a class="button" href="/docs">Open docs</a>
          <a class="button" href="/db">Open db</a>
          <a class="button" href="/api/docs">Registry API</a>
        </div>
      </div>
      <section class="card summary">
        <div class="summary-row"><strong>Ingress host</strong><span>${escapeHtml(data.ingress.ITERATE_INGRESS_HOST ?? "unset")}</span></div>
        <div class="summary-row"><strong>Routing type</strong><span>${escapeHtml(data.ingress.ITERATE_INGRESS_ROUTING_TYPE)}</span></div>
        <div class="summary-row"><strong>Default service</strong><span>${escapeHtml(data.ingress.ITERATE_INGRESS_DEFAULT_SERVICE)}</span></div>
      </section>
      <div class="columns">
        <section class="card">
          <h2>Docs Sources</h2>
          <ul class="list">${docsRows}</ul>
        </section>
        <section class="card">
          <h2>DB Sources</h2>
          <ul class="list">${dbRows}</ul>
        </section>
        <section class="card">
          <h2>Routes</h2>
          <ul class="list">${routeRows}</ul>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function renderScalarDocsHtml(sources: ReturnType<typeof listOpenApiSources>): string {
  const scalarSources = sources.map((source, index) => ({
    title: source.title,
    url: source.specUrl,
    default: index === 0,
  }));
  const scalarConfig = {
    title: "jonasland API Docs",
    layout: "modern",
    defaultOpenAllTags: true,
    operationTitleSource: "summary",
    operationsSorter: "method",
    defaultHttpClient: {
      targetKey: "shell",
      clientKey: "curl",
    },
    documentDownloadType: "direct",
    telemetry: false,
    sources: scalarSources,
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jonasland API Docs</title>
  </head>
  <body>
    <div id="app" data-config="${escapeHtml(JSON.stringify(scalarConfig))}"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      const config = JSON.parse(document.getElementById("app").dataset.config)
      const tagName = (tag) =>
        typeof tag === "string"
          ? tag
          : tag && typeof tag.name === "string"
            ? tag.name
            : ""
      config.tagsSorter = (a, b) => {
        const aName = tagName(a).toLowerCase()
        const bName = tagName(b).toLowerCase()
        const aIsService = aName === "service"
        const bIsService = bName === "service"
        if (aIsService && !bIsService) return 1
        if (!aIsService && bIsService) return -1
        return aName.localeCompare(bName)
      }
      Scalar.createApiReference("#app", config)
    </script>
  </body>
</html>`;
}

function createDbAuthorizeMiddleware(env: RegistryEnv) {
  return async (c: Context<ServiceAppEnv>, next: () => Promise<void>) => {
    const username = env.REGISTRY_DB_BASIC_AUTH_USER;
    if (!username) return await next();

    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Basic ")) {
      c.header("WWW-Authenticate", 'Basic realm="registry-db"');
      return c.text("Unauthorized", 401);
    }

    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const expected = `${username}:${env.REGISTRY_DB_BASIC_AUTH_PASS}`;
    if (decoded !== expected) {
      c.header("WWW-Authenticate", 'Basic realm="registry-db"');
      return c.text("Unauthorized", 401);
    }

    await next();
  };
}

function parseSqliteSpecs(sources: SqliteRouteSource[]): Array<{
  alias?: string;
  path: string;
  host?: string;
  title?: string;
}> {
  return sources.map((source) => ({
    alias: source.sqliteAlias,
    path: source.sqlitePath,
    host: source.host,
    title: source.title,
  }));
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

function buildSqliteTargets(
  specs: Array<{ alias?: string; path: string; host?: string; title?: string }>,
): SqliteTarget[] {
  const usedAliases = new Set<string>(["main", "temp"]);
  const seenPaths = new Set<string>();
  const targets: SqliteTarget[] = [];

  for (const spec of specs) {
    const resolvedPath = resolve(spec.path);
    if (seenPaths.has(resolvedPath)) continue;
    seenPaths.add(resolvedPath);
    const alias = claimAlias(spec.alias ?? resolvedPath, usedAliases);
    targets.push({
      alias,
      path: resolvedPath,
      ...(spec.host ? { host: spec.host } : {}),
      ...(spec.title ? { title: spec.title } : {}),
    });
  }

  return targets;
}

function resolveDefaultMainAlias(targets: SqliteTarget[]): string {
  if (targets.length === 0) {
    throw new Error("No sqlite targets configured.");
  }
  return targets[0].alias;
}

function buildAttachedMap(mainAlias: string): Record<string, string> {
  const attached: Record<string, string> = {};
  for (const target of sqliteTargets) {
    if (target.alias === mainAlias) continue;
    attached[target.alias] = target.path;
  }
  return attached;
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
    const headers = prepared.columns() as Array<{ name: string; type?: string | null }>;
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
  return { client, main, attached };
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

async function ensureDbRuntime(params: {
  routes: PersistedRoute[];
  env: RegistryEnv;
}): Promise<void> {
  const sources = listSqliteSources(params);
  const signature = JSON.stringify({
    sources: sources.map((source) => ({
      host: source.host,
      path: source.sqlitePath,
      alias: source.sqliteAlias,
    })),
    studioEmbedUrl: params.env.REGISTRY_DB_STUDIO_EMBED_URL,
    studioName: params.env.REGISTRY_DB_STUDIO_NAME,
  });
  if (signature === dbRuntimeSignature) return;

  const studioIframeUrl = new URL(params.env.REGISTRY_DB_STUDIO_EMBED_URL);
  if (!studioIframeUrl.searchParams.has("name")) {
    studioIframeUrl.searchParams.set("name", params.env.REGISTRY_DB_STUDIO_NAME);
  }
  studioOrigin = studioIframeUrl.origin;
  studioSrc = studioIframeUrl.toString();

  const nextTargets = buildSqliteTargets(parseSqliteSpecs(sources));
  if (nextTargets.length === 0) {
    sqliteTargets = [];
    sqliteTargetsByAlias = new Map();
    defaultMainAlias = "main";
    sqliteSessionByMainAlias.clear();
    dbRuntimeSignature = signature;
    return;
  }
  await Promise.all(
    nextTargets.map(async (target) => await mkdir(dirname(target.path), { recursive: true })),
  );
  sqliteTargets = nextTargets;
  sqliteTargetsByAlias = new Map(nextTargets.map((target) => [target.alias, target] as const));
  defaultMainAlias = resolveDefaultMainAlias(nextTargets);
  sqliteSessionByMainAlias.clear();
  dbRuntimeSignature = signature;
}

function resolveMainAlias(alias: string | undefined): string {
  if (alias && sqliteTargetsByAlias.has(alias)) return alias;
  return defaultMainAlias;
}

async function getDbRuntimeData(params: {
  routes: PersistedRoute[];
  env: RegistryEnv;
  mainAlias?: string;
}) {
  await ensureDbRuntime({ routes: params.routes, env: params.env });
  if (sqliteTargets.length === 0) {
    throw new ORPCError("NOT_FOUND", {
      message:
        "No sqlite databases discovered. Register routes with tag `sqlite` and metadata.sqlitePath.",
    });
  }
  const selectedMainAlias = resolveMainAlias(params.mainAlias);
  const session = await getSqliteSession(selectedMainAlias);
  return {
    studioSrc,
    selectedMainAlias,
    databases: sqliteTargets.map((target) => ({
      alias: target.alias,
      path: target.path,
      ...(target.host ? { host: target.host } : {}),
      ...(target.title ? { title: target.title } : {}),
    })),
    mainPath: session.main.path,
    attached: session.attached,
  };
}

async function executeDbRequest(params: {
  routes: PersistedRoute[];
  env: RegistryEnv;
  mainAlias?: string;
  request: DbQueryRequest;
}): Promise<DbQueryResponse> {
  await ensureDbRuntime({ routes: params.routes, env: params.env });
  if (sqliteTargets.length === 0) {
    return { type: params.request.type, id: params.request.id, error: "no_sqlite_databases" };
  }
  const session = await getSqliteSession(resolveMainAlias(params.mainAlias));
  if (params.request.type === "query") {
    try {
      const result = executeSqlStatement(
        session.client,
        rewriteMainAliasQualifier(params.request.statement, session.main.alias),
      );
      return {
        type: "query",
        id: params.request.id,
        data: transformLibsqlResultSet(result),
      };
    } catch (error) {
      return {
        type: "query",
        id: params.request.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const rewrittenStatements = params.request.statements.map((statement) =>
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
    return {
      type: "transaction",
      id: params.request.id,
      data: results.map(transformLibsqlResultSet),
    };
  } catch (error) {
    return {
      type: "transaction",
      id: params.request.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDbPageHtml(runtime: Awaited<ReturnType<typeof getDbRuntimeData>>): string {
  const allowedStudioOriginsJson = JSON.stringify(
    Array.from(new Set([studioOrigin, "https://studio.outerbase.com", "https://libsqlstudio.com"])),
  );
  const summaryJson = JSON.stringify({
    mainAlias: runtime.selectedMainAlias,
    mainPath: runtime.mainPath,
    attached: runtime.attached,
    databases: runtime.databases,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jonasland DB</title>
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
      .topbar select,
      .topbar button {
        color: #e2e8f0;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 12px;
      }
      .topbar .main-picker {
        min-width: min(52vw, 560px);
        max-width: min(72vw, 860px);
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
      .help-panel pre {
        margin: 8px 0 0 0;
        padding: 8px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 6px;
        background: #020617;
        overflow: auto;
      }
      .frame {
        border: 0;
        width: 100%;
        flex: 1;
        min-height: 0;
      }
      @media (max-width: 780px) {
        .help-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <div class="topbar">
        <label for="main-picker">Main DB</label>
        <select id="main-picker" class="main-picker"></select>
        <button id="info-toggle" type="button" aria-controls="help-panel" aria-expanded="false">
          Info
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
      const allowedStudioOrigins = ${allowedStudioOriginsJson};
      const summary = ${summaryJson};

      for (const database of summary.databases) {
        const option = document.createElement("option");
        option.value = database.alias;
        option.textContent = database.alias + " - " + database.path;
        mainPicker.appendChild(option);
      }

      mainPicker.value = summary.mainAlias;
      mainPicker.addEventListener("change", () => {
        const url = new URL(window.location.href);
        if (mainPicker.value === summary.mainAlias) {
          url.searchParams.delete("main");
        } else {
          url.searchParams.set("main", mainPicker.value);
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

      const connectedDatabases = summary.databases
        .map((database) => ({ name: database.alias, path: database.path }))
        .concat([{ name: "main", path: summary.mainPath }]);
      const connectedRows = connectedDatabases
        .map((database) => "<li><code>" + escapeHtml(database.name) + "</code> -> <code>" + escapeHtml(database.path) + "</code></li>")
        .join("");
      const helpQueryExamples = [
        "-- List tables in the current main database",
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;",
        "",
        "-- List 20 recent rows from a table you discover above",
        "SELECT * FROM main.your_table_name LIMIT 20;",
      ].join("\\n");
      helpPanel.innerHTML =
        "<div class='help-grid'>" +
          "<section>" +
            "<h3 class='help-section-title'>Connected databases</h3>" +
            "<ul class='help-db-list'>" + connectedRows + "</ul>" +
          "</section>" +
          "<section>" +
            "<h3 class='help-section-title'>How to query</h3>" +
            "<pre>" + helpQueryExamples + "</pre>" +
          "</section>" +
        "</div>";

      infoToggle.addEventListener("click", () => {
        helpPanel.hidden = !helpPanel.hidden;
        infoToggle.setAttribute("aria-expanded", String(!helpPanel.hidden));
      });

      async function relay(message, targetOrigin) {
        const response = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mainAlias: summary.mainAlias,
            request: message,
          }),
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

async function synchronizeCaddyFromStore(params: {
  store: ServicesStore;
  env: RegistryEnv;
  forceReload?: boolean;
}) {
  const routes = await params.store.listRoutes();
  const result = await reconcileCaddyConfig({
    routes,
    caddyConfigDir: CADDY_CONFIG_DIR,
    rootCaddyfilePath: CADDY_ROOT_CADDYFILE,
    caddyBinPath: CADDY_BIN_PATH,
    iterateIngressHost: params.env.ITERATE_INGRESS_HOST,
    iterateIngressRoutingType: params.env.ITERATE_INGRESS_ROUTING_TYPE,
    iterateIngressDefaultService: params.env.ITERATE_INGRESS_DEFAULT_SERVICE,
    forceReload: params.forceReload,
  });
  return { routes, result };
}

async function upsertRouteAndSynchronize(params: {
  input: {
    host: string;
    target: string;
    metadata?: Record<string, string>;
    tags?: string[];
    caddyDirectives?: string[];
  };
  context: RegistryContext;
}) {
  const route = await params.context.store.upsertRoute(params.input);
  const sync = await synchronizeCaddyFromStore({
    store: params.context.store,
    env: params.context.env,
  });
  return { route, routes: sync.routes, sync: sync.result };
}

async function removeRouteAndSynchronize(params: { host: string; context: RegistryContext }) {
  const removed = await params.context.store.removeRoute(params.host);
  const sync = await synchronizeCaddyFromStore({
    store: params.context.store,
    env: params.context.env,
  });
  return { removed, routes: sync.routes, sync: sync.result };
}

async function handleCaddyLoadInvocation(params: {
  input: {
    listenAddress?: string;
    adminUrl?: string;
    apply?: boolean;
  };
  context: RegistryContext;
}) {
  const listenAddress = params.input.listenAddress ?? CADDY_LISTEN_ADDRESS;
  const adminUrl = params.input.adminUrl ?? CADDY_ADMIN_URL;
  const routes = await params.context.store.listRoutes();
  const payload = {
    note: "registry now uses caddy validate/reload with file fragments in the fixed caddy config directory",
    listenAddress,
    routeHosts: routes.map((route) => route.host),
    caddyConfigDir: CADDY_CONFIG_DIR,
    caddyRootCaddyfile: CADDY_ROOT_CADDYFILE,
  };
  const invocation = {
    method: "POST" as const,
    path: "/load" as const,
    url: `${adminUrl}/load`,
    body: payload,
  };
  if (params.input.apply === true) {
    await synchronizeCaddyFromStore({
      store: params.context.store,
      env: params.context.env,
      forceReload: true,
    });
  }
  return {
    invocation,
    routeCount: routes.length,
    applied: params.input.apply === true,
  };
}

export async function ensureInitialCaddySynchronization(params: {
  store: ServicesStore;
  env: RegistryEnv;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const sync = await synchronizeCaddyFromStore({
        store: params.store,
        env: params.env,
        forceReload: true,
      });
      serviceLog.info({
        event: "registry.caddy.initial_sync_ok",
        route_count: sync.routes.length,
        changed_files: sync.result.changedFiles.length,
        removed_files: sync.result.removedFiles.length,
        attempt,
      });
      return;
    } catch (error) {
      lastError = error;
      serviceLog.warn({
        event: "registry.caddy.initial_sync_retry",
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await sleep(1_000);
    }
  }
  throw new Error("failed initial caddy synchronization", { cause: lastError });
}

export async function ensureSeededRoutes(params: {
  store: ServicesStore;
  env: RegistryEnv;
}): Promise<void> {
  const seededRoutes = [
    {
      host: "registry.iterate.localhost",
      target: `127.0.0.1:${String(params.env.REGISTRY_SERVICE_PORT)}`,
      tags: ["seeded", "registry", "openapi", "sqlite"],
      metadata: {
        source: "registry-seed",
        title: "Registry Service",
        openapiPath: "/api/openapi.json",
        sqlitePath: params.env.REGISTRY_DB_PATH,
        sqliteAlias: "registry",
      },
    },
    {
      host: "events.iterate.localhost",
      target: "127.0.0.1:17320",
      tags: ["seeded", "events", "openapi"],
      metadata: {
        source: "registry-seed",
        title: "Events Service",
        openapiPath: "/api/openapi.json",
      },
    },
    {
      host: "openobserve.iterate.localhost",
      target: "127.0.0.1:5080",
      caddyDirectives: [
        'header_up Authorization "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="',
      ],
      tags: ["seeded", "observability"],
      metadata: {
        source: "registry-seed",
        title: "OpenObserve",
      },
    },
    {
      host: "otel-collector.iterate.localhost",
      target: "127.0.0.1:15333",
      tags: ["seeded"],
      metadata: { source: "registry-seed", title: "OTEL Collector" },
    },
    {
      host: "frp.iterate.localhost",
      target: "127.0.0.1:27000",
      caddyDirectives: ["stream_close_delay 5m"],
      tags: ["seeded"],
      metadata: { source: "registry-seed", title: "FRP" },
    },
  ] as const;

  for (const route of seededRoutes) {
    await params.store.upsertRoute({
      host: route.host,
      target: route.target,
      metadata: route.metadata,
      tags: [...route.tags],
      caddyDirectives: "caddyDirectives" in route ? [...route.caddyDirectives] : [],
    });
  }
}

export const registryRouter = os.router({
  getPublicURL: os.getPublicURL.handler(async ({ input, context }) => {
    try {
      return {
        publicURL: resolvePublicUrl({
          ITERATE_INGRESS_HOST: context.env.ITERATE_INGRESS_HOST,
          ITERATE_INGRESS_ROUTING_TYPE: context.env.ITERATE_INGRESS_ROUTING_TYPE,
          ITERATE_INGRESS_DEFAULT_SERVICE: context.env.ITERATE_INGRESS_DEFAULT_SERVICE,
          internalURL: input.internalURL,
        }),
      };
    } catch (error) {
      if (error instanceof ResolvePublicUrlError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message, cause: error });
      }
      throw error;
    }
  }),
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true,
      service: context.serviceName,
      version: registryServiceManifest.version,
    })),
    sql: os.service.sql.handler(async ({ input, context }) => {
      const startedAt = Date.now();
      const result = transformSqlResultSet(await context.store.executeSql(input.statement));
      infoFromContext(context, "registry.service.sql", {
        service: context.serviceName,
        request_id: context.requestId,
        duration_ms: Date.now() - startedAt,
        rows: result.rows.length,
      });
      return result;
    }),
    debug: os.service.debug.handler(async () => {
      const env: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(process.env)) {
        env[key] = value ?? null;
      }
      const memoryUsage = process.memoryUsage();
      return {
        pid: process.pid,
        ppid: process.ppid,
        uptimeSec: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
        cwd: process.cwd(),
        execPath: process.execPath,
        argv: process.argv,
        env,
        memoryUsage: {
          rss: memoryUsage.rss,
          heapTotal: memoryUsage.heapTotal,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          arrayBuffers: memoryUsage.arrayBuffers,
        },
      };
    }),
  },
  landing: {
    get: os.landing.get.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      return buildLandingData({ routes, env: context.env });
    }),
  },
  docs: {
    listSources: os.docs.listSources.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      const sources = listOpenApiSources({ routes, env: context.env });
      return { sources, total: sources.length };
    }),
  },
  db: {
    listSources: os.db.listSources.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      const sources = listSqliteSources({ routes, env: context.env });
      return { sources, total: sources.length };
    }),
    runtime: os.db.runtime.handler(async ({ input, context }) => {
      const routes = await context.store.listRoutes();
      return await getDbRuntimeData({
        routes,
        env: context.env,
        mainAlias: input.mainAlias,
      });
    }),
    query: os.db.query.handler(async ({ input, context }) => {
      const routes = await context.store.listRoutes();
      return await executeDbRequest({
        routes,
        env: context.env,
        mainAlias: input.mainAlias,
        request: input.request,
      });
    }),
  },
  routes: {
    upsert: os.routes.upsert.handler(async ({ input, context }) => {
      const { route, routes, sync } = await upsertRouteAndSynchronize({ input, context });
      infoFromContext(context, "registry.routes.upsert", {
        host: route.host,
        route_count: routes.length,
        caddy_reloaded: sync.reloaded,
        caddy_changed_files: sync.changedFiles.length,
        caddy_removed_files: sync.removedFiles.length,
      });
      return { route, routeCount: routes.length };
    }),
    remove: os.routes.remove.handler(async ({ input, context }) => {
      const { removed, routes, sync } = await removeRouteAndSynchronize({
        host: input.host,
        context,
      });
      infoFromContext(context, "registry.routes.remove", {
        host: input.host,
        removed,
        route_count: routes.length,
        caddy_reloaded: sync.reloaded,
        caddy_changed_files: sync.changedFiles.length,
        caddy_removed_files: sync.removedFiles.length,
      });
      return { removed, routeCount: routes.length };
    }),
    list: os.routes.list.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      return { routes, total: routes.length };
    }),
    caddyLoadInvocation: os.routes.caddyLoadInvocation.handler(
      async ({ input, context }) => await handleCaddyLoadInvocation({ input, context }),
    ),
  },
  caddy: {
    loadInvocation: os.caddy.loadInvocation.handler(
      async ({ input, context }) => await handleCaddyLoadInvocation({ input, context }),
    ),
  },
  config: {
    get: os.config.get.handler(async ({ input, context }) => {
      const entry = await context.store.getConfig(input.key);
      return { found: entry !== null, ...(entry ? { entry } : {}) };
    }),
    set: os.config.set.handler(async ({ input, context }) => {
      const entry = await context.store.setConfig({ key: input.key, value: input.value });
      return { entry };
    }),
    list: os.config.list.handler(async ({ context }) => {
      const entries = await context.store.listConfig();
      return { entries, total: entries.length };
    }),
  },
});

const app = new Hono<ServiceAppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
applyServiceMiddleware(app);

const store = await ensureStore();
const env = getEnv();
const openAPIHandler = createServiceOpenAPIHandler({
  router: registryRouter,
  title: "jonasland registry-service API",
  version: registryServiceManifest.version,
});
const wsHandler = new WebSocketRPCHandler(registryRouter);
const dbAuthorize = createDbAuthorizeMiddleware(env);

app.use("/db", dbAuthorize);
app.use("/api/db/*", dbAuthorize);

app.get(
  "/orpc/ws",
  upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => {
      const requestId = randomUUID();
      serviceLog.info({ event: "orpc.ws.upgrade", pathname: "/orpc/ws" });
      void wsHandler.upgrade(ws.raw as import("ws").WebSocket, {
        context: {
          requestId,
          serviceName,
          log: createServiceRequestLogger({ requestId, method: "WS", path: "/orpc/ws" }),
          store,
          env,
        },
      });
    },
  })),
);

app.get("/", async (c) => {
  const routes = await store.listRoutes();
  return c.html(buildLandingHtml(buildLandingData({ routes, env })), 200, {
    "cache-control": "no-cache",
  });
});

app.get("/docs", async (c) => {
  const routes = await store.listRoutes();
  return c.html(renderScalarDocsHtml(listOpenApiSources({ routes, env })), 200, {
    "cache-control": "no-cache",
  });
});

app.get("/db", async (c) => {
  const routes = await store.listRoutes();
  const runtime = await getDbRuntimeData({
    routes,
    env,
    mainAlias: c.req.query("main") ?? undefined,
  });
  return c.html(buildDbPageHtml(runtime), 200, {
    "cache-control": "no-cache",
  });
});

applyOpenAPIRoute(app, openAPIHandler, serviceName, {
  extraContext: () => ({ store, env }),
});

export default app;
export { injectWebSocket, store, env, serviceName, getOtelRuntimeConfig };
