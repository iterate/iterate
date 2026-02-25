import { Hono } from "hono";
import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, type RequestHeadersPluginContext } from "@orpc/server/plugins";
import { z } from "zod/v4";

export type ProxyWorkerEnv = {
  DB: D1Database;
  CF_PROXY_WORKER_API_TOKEN: string;
};

export type RouteHeaders = Record<string, string>;
export type RouteMetadata = Record<string, unknown>;
export type RouteStatus = "active" | "expired" | "disabled";

export type RouteRecord = {
  route: string;
  target: string;
  headers: RouteHeaders;
  metadata: RouteMetadata;
  status: RouteStatus;
  ttlSeconds: number | null;
  expiresAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RouteRow = {
  route: string;
  target: string;
  headers: string;
  metadata: string;
  status: string;
  ttl_seconds: number | null;
  expires_at: string | null;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ResolvedRoute = RouteRecord & {
  targetUrl: URL;
};

export type SetRouteInput = {
  route: string;
  target: string;
  headers?: RouteHeaders;
  metadata?: RouteMetadata;
  ttlSeconds?: number | null;
};

class InputError extends Error {}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseJsonObject(value: string, field: "headers" | "metadata"): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InputError(`${field} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`Invalid JSON in ${field}`);
  }
}

function rowToRouteRecord(row: RouteRow): RouteRecord {
  const status: RouteStatus =
    row.status === "active" || row.status === "expired" || row.status === "disabled"
      ? row.status
      : "active";

  return {
    route: row.route,
    target: row.target,
    headers: parseJsonObject(row.headers, "headers") as RouteHeaders,
    metadata: parseJsonObject(row.metadata, "metadata"),
    status,
    ttlSeconds: row.ttl_seconds,
    expiresAt: row.expires_at,
    expiredAt: row.expired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length < 1 || hostname.length > 253) return false;
  if (!/^[a-z0-9._-]+$/.test(hostname)) return false;
  if (hostname.includes("..")) return false;

  const labels = hostname.split(".");
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[a-z0-9_-]+$/.test(label);
  });
}

function stripPort(rawHost: string): string {
  if (rawHost.startsWith("[")) {
    const closeBracketIndex = rawHost.indexOf("]");
    if (closeBracketIndex > 0) {
      return rawHost.slice(1, closeBracketIndex);
    }
  }

  const firstColonIndex = rawHost.indexOf(":");
  if (firstColonIndex === -1) return rawHost;
  return rawHost.slice(0, firstColonIndex);
}

export function normalizeInboundHost(rawHost: string | null): string | null {
  if (!rawHost) return null;
  const stripped = stripPort(rawHost.trim().toLowerCase()).replace(/\.$/, "");
  if (!stripped) return null;
  return stripped;
}

export function normalizeRouteKey(input: string): string {
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (!raw) throw new InputError("route is required");

  if (raw.startsWith("*.")) {
    const suffix = raw.slice(2);
    if (!isValidHostname(suffix)) {
      throw new InputError(`Invalid wildcard route: ${input}`);
    }
    return `*.${suffix}`;
  }

  if (!isValidHostname(raw)) {
    throw new InputError(`Invalid route: ${input}`);
  }

  return raw;
}

export function parseTargetUrl(target: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new InputError("target must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InputError("target URL must use http or https");
  }

  return parsed;
}

export function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function toSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function computeExpiresAt(ttlSeconds: number | null | undefined): string | null {
  if (ttlSeconds === null || ttlSeconds === undefined) return null;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return toSqliteTimestamp(expiresAt);
}

function isTtlExpired(route: RouteRecord, nowSql: string): boolean {
  return route.expiresAt !== null && route.expiresAt <= nowSql;
}

async function runSchemaStatement(db: D1Database, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) {
      throw error;
    }
  }
}

async function markRouteExpired(db: D1Database, routeKey: string, nowSql: string): Promise<void> {
  await db
    .prepare(`
      UPDATE routes
      SET
        status = 'expired',
        expired_at = COALESCE(expired_at, ?2),
        updated_at = CURRENT_TIMESTAMP
      WHERE route = ?1
    `)
    .bind(routeKey, nowSql)
    .run();
}

export async function ensureSchema(db: D1Database): Promise<void> {
  await runSchemaStatement(
    db,
    `
    CREATE TABLE IF NOT EXISTS routes (
      route TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      headers TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'disabled')),
      ttl_seconds INTEGER,
      expires_at TEXT,
      expired_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `,
  );

  // Keep runtime schema self-healing for already-created early versions of the table.
  await runSchemaStatement(
    db,
    "ALTER TABLE routes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  );
  await runSchemaStatement(db, "ALTER TABLE routes ADD COLUMN ttl_seconds INTEGER");
  await runSchemaStatement(db, "ALTER TABLE routes ADD COLUMN expires_at TEXT");
  await runSchemaStatement(db, "ALTER TABLE routes ADD COLUMN expired_at TEXT");

  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_routes_status_expires_at ON routes(status, expires_at)",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_routes_expires_at ON routes(expires_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_routes_status ON routes(status)").run();
}

export async function listRoutes(db: D1Database): Promise<RouteRecord[]> {
  await ensureSchema(db);

  const rows = await db
    .prepare(`
      SELECT route, target, headers, metadata, status, ttl_seconds, expires_at, expired_at, created_at, updated_at
      FROM routes
      ORDER BY route ASC
    `)
    .all<RouteRow>();

  return (rows.results ?? []).map(rowToRouteRecord);
}

export async function setRoute(db: D1Database, input: SetRouteInput): Promise<RouteRecord> {
  await ensureSchema(db);

  const route = normalizeRouteKey(input.route);
  const target = parseTargetUrl(input.target).toString();
  const headers = input.headers ?? {};
  const metadata = input.metadata ?? {};
  const ttlSeconds = input.ttlSeconds ?? null;
  const expiresAt = computeExpiresAt(ttlSeconds);

  await db
    .prepare(`
      INSERT INTO routes (route, target, headers, metadata, status, ttl_seconds, expires_at, expired_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(route) DO UPDATE SET
        target = excluded.target,
        headers = excluded.headers,
        metadata = excluded.metadata,
        status = 'active',
        ttl_seconds = excluded.ttl_seconds,
        expires_at = excluded.expires_at,
        expired_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(route, target, JSON.stringify(headers), JSON.stringify(metadata), ttlSeconds, expiresAt)
    .run();

  const row = await db
    .prepare(`
      SELECT route, target, headers, metadata, status, ttl_seconds, expires_at, expired_at, created_at, updated_at
      FROM routes
      WHERE route = ?1
    `)
    .bind(route)
    .first<RouteRow>();

  if (!row) throw new Error("Failed to read route after upsert");
  return rowToRouteRecord(row);
}

export async function deleteRoute(db: D1Database, routeInput: string): Promise<boolean> {
  await ensureSchema(db);

  const route = normalizeRouteKey(routeInput);

  const result = await db
    .prepare(`
      DELETE FROM routes
      WHERE route = ?1
    `)
    .bind(route)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function resolveRoute(
  db: D1Database,
  request: Request,
): Promise<ResolvedRoute | null> {
  await ensureSchema(db);

  const host = normalizeInboundHost(request.headers.get("host"));
  if (!host) return null;
  const nowSql = toSqliteTimestamp(new Date());

  const exactRow = await db
    .prepare(`
      SELECT route, target, headers, metadata, status, ttl_seconds, expires_at, expired_at, created_at, updated_at
      FROM routes
      WHERE route = ?1
      LIMIT 1
    `)
    .bind(host)
    .first<RouteRow>();

  if (exactRow) {
    const exact = rowToRouteRecord(exactRow);
    if (exact.status !== "expired" && exact.status !== "disabled") {
      if (isTtlExpired(exact, nowSql)) {
        await markRouteExpired(db, exact.route, nowSql);
      } else {
        return { ...exact, targetUrl: parseTargetUrl(exact.target) };
      }
    }
  }

  const wildcardRows = await db
    .prepare(`
      SELECT route, target, headers, metadata, status, ttl_seconds, expires_at, expired_at, created_at, updated_at
      FROM routes
      WHERE route LIKE '*.%'
    `)
    .all<RouteRow>();

  const wildcardMatches = (wildcardRows.results ?? [])
    .map(rowToRouteRecord)
    .filter((route) => {
      if (!route.route.startsWith("*.")) return false;
      const suffix = route.route.slice(2);
      return host.length > suffix.length && host.endsWith(`.${suffix}`);
    })
    .sort((a, b) => b.route.length - a.route.length);

  for (const wildcardMatch of wildcardMatches) {
    if (wildcardMatch.status === "expired" || wildcardMatch.status === "disabled") {
      continue;
    }
    if (isTtlExpired(wildcardMatch, nowSql)) {
      await markRouteExpired(db, wildcardMatch.route, nowSql);
      continue;
    }
    return { ...wildcardMatch, targetUrl: parseTargetUrl(wildcardMatch.target) };
  }

  return null;
}

export function buildUpstreamUrl(targetUrl: URL, requestUrl: URL): URL {
  const upstreamUrl = new URL(targetUrl.toString());

  const targetPathPrefix =
    upstreamUrl.pathname === "/" ? "" : upstreamUrl.pathname.replace(/\/$/, "");
  const inboundPath = requestUrl.pathname || "/";

  upstreamUrl.pathname = `${targetPathPrefix}${inboundPath}` || "/";
  upstreamUrl.search = requestUrl.search;
  upstreamUrl.hash = "";

  return upstreamUrl;
}

export function createUpstreamHeaders(
  request: Request,
  targetHost: string,
  routeHeaders: RouteHeaders,
): Headers {
  const headers = new Headers(request.headers);
  const isWebSocketRequest = request.headers.get("upgrade")?.toLowerCase() === "websocket";

  for (const headerName of HOP_BY_HOP_HEADERS) {
    if (isWebSocketRequest && (headerName === "connection" || headerName === "upgrade")) {
      continue;
    }
    headers.delete(headerName);
  }

  headers.set("host", targetHost);

  for (const [headerName, headerValue] of Object.entries(routeHeaders)) {
    headers.set(headerName, headerValue);
  }

  return headers;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export async function proxyRequest(request: Request, env: ProxyWorkerEnv): Promise<Response> {
  const resolved = await resolveRoute(env.DB, request);
  if (!resolved) {
    return jsonError(404, "route_not_found");
  }

  const inboundUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(resolved.targetUrl, inboundUrl);
  const headers = createUpstreamHeaders(request, upstreamUrl.host, resolved.headers);

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : request.body;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(
      new Request(upstreamUrl.toString(), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      }),
    );
  } catch {
    return jsonError(502, "proxy_error");
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("x-cf-proxy-route", resolved.route);

  if (upstreamResponse.status === 101) {
    const init = {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
      webSocket: (upstreamResponse as Response & { webSocket?: WebSocket | null }).webSocket,
    };
    return new Response(null, init as ResponseInit);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

type ORPCContext = RequestHeadersPluginContext & {
  env: ProxyWorkerEnv;
};

const baseProcedure = os.$context<ORPCContext>();

const authProcedure = baseProcedure.use(async ({ context, next }) => {
  const expectedToken = context.env.CF_PROXY_WORKER_API_TOKEN;
  const providedToken = readBearerToken(context.reqHeaders?.get("authorization") ?? null);

  if (!providedToken || providedToken !== expectedToken) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Missing or invalid Authorization header",
    });
  }

  return next();
});

const SetRoute = z.object({
  route: z.string().min(1),
  target: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60 * 60)
    .nullable()
    .optional(),
});

const DeleteRoute = z.object({
  route: z.string().min(1),
});

export const listRoutesProcedure = authProcedure.handler(async ({ context }) => {
  return listRoutes(context.env.DB);
});

export const setRouteProcedure = authProcedure
  .input(SetRoute)
  .handler(async ({ context, input }) => {
    try {
      return await setRoute(context.env.DB, input);
    } catch (error) {
      if (error instanceof InputError) {
        throw new ORPCError("BAD_REQUEST", {
          message: error.message,
        });
      }
      throw error;
    }
  });

export const deleteRouteProcedure = authProcedure
  .input(DeleteRoute)
  .handler(async ({ context, input }) => {
    try {
      const deleted = await deleteRoute(context.env.DB, input.route);
      return { deleted };
    } catch (error) {
      if (error instanceof InputError) {
        throw new ORPCError("BAD_REQUEST", {
          message: error.message,
        });
      }
      throw error;
    }
  });

export const appRouter = {
  listRoutes: listRoutesProcedure,
  setRoute: setRouteProcedure,
  deleteRoute: deleteRouteProcedure,
};

export type ProxyWorkerRouter = typeof appRouter;

const orpcHandler = new RPCHandler(appRouter, {
  plugins: [new RequestHeadersPlugin()],
  interceptors: [
    onError((error) => {
      if (error instanceof ORPCError) return;
      throw error;
    }),
  ],
});

export const app = new Hono<{ Bindings: ProxyWorkerEnv }>();

app.get("/health", () => new Response("OK", { status: 200 }));

app.all("/api/orpc/*", async (c) => {
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: {
      env: c.env,
    },
  });

  if (!matched) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.newResponse(response.body, response);
});

app.all("*", async (c) => {
  return proxyRequest(c.req.raw, c.env);
});

export default app;
