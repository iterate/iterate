import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ORPCError } from "@orpc/server";
import {
  transformLibsqlResultSet,
  type ServiceAppEnv,
  type SqlResultSet,
} from "@iterate-com/shared/jonasland";
import { type Context } from "hono";
import { type RegistryEnv } from "./context.ts";
import { deriveAliasFromPath, listSqliteSources, type SqliteRouteSource } from "./docs.ts";
import type { PersistedRoute } from "./store.ts";

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

export type DbQueryRequest =
  | { type: "query"; id: number; statement: string }
  | { type: "transaction"; id: number; statements: string[] };

export type DbQueryResponse =
  | { type: "query"; id: number; data: ReturnType<typeof transformLibsqlResultSet>; error?: string }
  | {
      type: "transaction";
      id: number;
      data: Array<ReturnType<typeof transformLibsqlResultSet>>;
      error?: string;
    }
  | { type: "query" | "transaction"; id: number; error: string };

let dbRuntimeSignature = "";
let studioOrigin = "";
let studioSrc = "";
let sqliteTargets: SqliteTarget[] = [];
let sqliteTargetsByAlias = new Map<string, SqliteTarget>();
let defaultMainAlias = "main";
const sqliteSessionByMainAlias = new Map<string, Promise<SqliteSession>>();

export function createDbAuthorizeMiddleware(env: RegistryEnv) {
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

export async function getDbRuntimeData(params: {
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

export async function executeDbRequest(params: {
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
