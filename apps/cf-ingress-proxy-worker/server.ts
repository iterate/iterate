import { Hono } from "hono";
import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, type RequestHeadersPluginContext } from "@orpc/server/plugins";
import { typeid } from "typeid-js";
import { z } from "zod/v4";
import {
  findPatternConflicts,
  normalizePattern,
  normalizeRouteId,
  RouteInputError,
  type PatternConflict,
} from "./route-conflicts.ts";
import {
  deleteRouteById,
  deleteRoutePatternsByRouteId,
  insertRoute,
  insertRoutePattern,
  selectRouteById,
  selectRoutePatterns,
  selectRoutePatternsByRouteId,
  selectRoutes,
  updateRouteMetadata,
} from "./sql/queries.ts";
import { parseWorkerEnv, type ProxyWorkerEnv, type RawProxyWorkerEnv } from "./env.ts";

export type RouteHeaders = Record<string, string>;
export type RouteMetadata = Record<string, unknown>;

export type RoutePatternRecord = {
  patternId: number;
  pattern: string;
  target: string;
  headers: RouteHeaders;
  createdAt: string;
  updatedAt: string;
};

export type RouteRecord = {
  routeId: string;
  metadata: RouteMetadata;
  patterns: RoutePatternRecord[];
  createdAt: string;
  updatedAt: string;
};

export type ResolvedRoute = {
  routeId: string;
  pattern: string;
  targetUrl: URL;
  headers: RouteHeaders;
  metadata: RouteMetadata;
};

type RouteRow = {
  id: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type RoutePatternRow = {
  id: number;
  route_id: string;
  pattern: string;
  target: string;
  headers: string;
  created_at: string;
  updated_at: string;
};

class RouteConflictError extends Error {
  public conflicts: PatternConflict[];

  public constructor(conflicts: PatternConflict[]) {
    super("Pattern conflicts with existing route(s)");
    this.conflicts = conflicts;
  }
}

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function parseJsonObject(value: string, field: "headers" | "metadata"): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RouteInputError(`${field} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RouteInputError) throw error;
    throw new RouteInputError(`Invalid JSON in ${field}`);
  }
}

function normalizeInboundHost(rawHost: string | null): string | null {
  if (!rawHost) return null;
  const first = rawHost.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return null;
  let host: string;
  if (first.startsWith("[")) {
    const endBracket = first.indexOf("]");
    if (endBracket === -1) return null;
    host = first.slice(1, endBracket);
  } else {
    const lastColon = first.lastIndexOf(":");
    if (lastColon !== -1 && first.indexOf(":") === lastColon) {
      host = first.slice(0, lastColon);
    } else {
      host = first;
    }
  }
  return host.replace(/\.$/, "") || null;
}

function patternMatchesHost(pattern: string, host: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === host;
  }
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(host);
}

function comparePatternPriority(a: RoutePatternRow, b: RoutePatternRow): number {
  const aExact = a.pattern.includes("*") ? 0 : 1;
  const bExact = b.pattern.includes("*") ? 0 : 1;
  if (aExact !== bExact) {
    return bExact - aExact;
  }
  if (a.pattern.length !== b.pattern.length) {
    return b.pattern.length - a.pattern.length;
  }
  return a.id - b.id;
}

function parseTargetUrl(target: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new RouteInputError("target must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RouteInputError("target URL must use http or https");
  }

  return parsed;
}

function normalizeHeaders(headers: RouteHeaders | undefined): RouteHeaders {
  if (!headers) return {};
  const normalized: RouteHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    if (!name) {
      throw new RouteInputError("header names cannot be empty");
    }
    normalized[name] = value;
  }
  return normalized;
}

function normalizeMetadata(metadata: RouteMetadata | undefined): RouteMetadata {
  return metadata ?? {};
}

function normalizePatternInputs(
  patterns: Array<{ pattern: string; target: string; headers?: RouteHeaders }>,
): Array<{ pattern: string; target: string; headers: RouteHeaders }> {
  const normalized = patterns.map((pattern) => {
    const normalizedPattern = normalizePattern(pattern.pattern);
    const normalizedTarget = parseTargetUrl(pattern.target).toString();
    return {
      pattern: normalizedPattern,
      target: normalizedTarget,
      headers: normalizeHeaders(pattern.headers),
    };
  });

  const seen = new Set<string>();
  for (const item of normalized) {
    if (seen.has(item.pattern)) {
      throw new RouteInputError(`Duplicate pattern in request: ${item.pattern}`);
    }
    seen.add(item.pattern);
  }

  return normalized;
}

function patternRowToRecord(row: RoutePatternRow): RoutePatternRecord {
  return {
    patternId: row.id,
    pattern: row.pattern,
    target: row.target,
    headers: parseJsonObject(row.headers, "headers") as RouteHeaders,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function routeRowToRecord(row: RouteRow, patterns: RoutePatternRow[]): RouteRecord {
  return {
    routeId: row.id,
    metadata: parseJsonObject(row.metadata, "metadata"),
    patterns: patterns.map(patternRowToRecord),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRouteRowsById(
  db: D1Database,
  routeId: string,
): Promise<{
  route: RouteRow | null;
  patterns: RoutePatternRow[];
}> {
  const normalizedRouteId = normalizeRouteId(routeId);
  const route = await selectRouteById(db, { routeId: normalizedRouteId });
  const patterns = await selectRoutePatternsByRouteId(db, { routeId: normalizedRouteId });

  return {
    route,
    patterns,
  };
}

export async function getRoute(db: D1Database, routeId: string): Promise<RouteRecord | null> {
  const rows = await getRouteRowsById(db, routeId);
  if (!rows.route) return null;
  return routeRowToRecord(rows.route, rows.patterns);
}

export async function listRoutes(db: D1Database): Promise<RouteRecord[]> {
  const routeRows = await selectRoutes(db);
  const patternRows = await selectRoutePatterns(db);

  const patternsByRouteId = new Map<string, RoutePatternRow[]>();
  for (const pattern of patternRows) {
    const group = patternsByRouteId.get(pattern.route_id) ?? [];
    group.push(pattern);
    patternsByRouteId.set(pattern.route_id, group);
  }

  return routeRows.map((route) => {
    return routeRowToRecord(route, patternsByRouteId.get(route.id) ?? []);
  });
}

export async function createRoute(
  db: D1Database,
  params: {
    typeIdPrefix: string;
    patterns: Array<{ pattern: string; target: string; headers?: RouteHeaders }>;
    metadata?: RouteMetadata;
  },
): Promise<RouteRecord> {
  const normalizedPatterns = normalizePatternInputs(params.patterns);
  const conflicts = await findPatternConflicts({
    db,
    patterns: normalizedPatterns.map((pattern) => pattern.pattern),
  });
  if (conflicts.length > 0) {
    throw new RouteConflictError(conflicts);
  }

  const routeId = typeid(params.typeIdPrefix).toString();
  const metadata = normalizeMetadata(params.metadata);

  await insertRoute(db, {
    routeId,
    metadata: JSON.stringify(metadata),
  });
  for (const pattern of normalizedPatterns) {
    await insertRoutePattern(db, {
      routeId,
      pattern: pattern.pattern,
      target: pattern.target,
      headers: JSON.stringify(pattern.headers),
    });
  }

  const created = await getRoute(db, routeId);
  if (!created) throw new Error("Failed to read route after create");
  return created;
}

export async function updateRoute(
  db: D1Database,
  params: {
    routeId: string;
    patterns: Array<{ pattern: string; target: string; headers?: RouteHeaders }>;
    metadata?: RouteMetadata;
  },
): Promise<RouteRecord> {
  const routeId = normalizeRouteId(params.routeId);
  const existing = await getRoute(db, routeId);
  if (!existing) {
    throw new ORPCError("NOT_FOUND", { message: "Route not found" });
  }

  const normalizedPatterns = normalizePatternInputs(params.patterns);
  const conflicts = await findPatternConflicts({
    db,
    patterns: normalizedPatterns.map((pattern) => pattern.pattern),
    excludeRouteId: routeId,
  });
  if (conflicts.length > 0) {
    throw new RouteConflictError(conflicts);
  }

  const metadata = normalizeMetadata(params.metadata);

  await updateRouteMetadata(
    db,
    {
      metadata: JSON.stringify(metadata),
    },
    {
      routeId,
    },
  );
  await deleteRoutePatternsByRouteId(db, { routeId });
  for (const pattern of normalizedPatterns) {
    await insertRoutePattern(db, {
      routeId,
      pattern: pattern.pattern,
      target: pattern.target,
      headers: JSON.stringify(pattern.headers),
    });
  }

  const updated = await getRoute(db, routeId);
  if (!updated) throw new Error("Failed to read route after update");
  return updated;
}

export async function deleteRoute(db: D1Database, routeId: string): Promise<boolean> {
  const normalizedRouteId = normalizeRouteId(routeId);
  const result = await deleteRouteById(db, { routeId: normalizedRouteId });
  return (result.changes ?? 0) > 0;
}

export async function resolveRoute(
  db: D1Database,
  request: Request,
): Promise<ResolvedRoute | null> {
  const host = normalizeInboundHost(request.headers.get("host"));
  if (!host) return null;

  const [routes, patterns] = await Promise.all([selectRoutes(db), selectRoutePatterns(db)]);
  const routeById = new Map(routes.map((route) => [route.id, route] as const));
  const winner = patterns
    .filter((pattern) => patternMatchesHost(pattern.pattern, host))
    .sort(comparePatternPriority)[0];
  if (!winner) return null;

  const route = routeById.get(winner.route_id);
  if (!route) return null;

  return {
    routeId: winner.route_id,
    pattern: winner.pattern,
    targetUrl: parseTargetUrl(winner.target),
    headers: parseJsonObject(winner.headers, "headers") as RouteHeaders,
    metadata: parseJsonObject(route.metadata, "metadata"),
  };
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

export function createUpstreamHeaders(request: Request, routeHeaders: RouteHeaders): Headers {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(routeHeaders)) {
    headers.set(name, value);
  }

  return headers;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function proxyRequest(request: Request, env: ProxyWorkerEnv): Promise<Response> {
  const resolved = await resolveRoute(env.DB, request);
  if (!resolved) {
    return jsonError(404, "route_not_found");
  }

  const inboundUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(resolved.targetUrl, inboundUrl);
  let upstreamRequest: Request = new Request(upstreamUrl.toString(), request);
  if (Object.keys(resolved.headers).length > 0) {
    const upstreamHeaders = createUpstreamHeaders(upstreamRequest, resolved.headers);
    upstreamRequest = new Request(upstreamRequest, { headers: upstreamHeaders });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest, { redirect: "manual" });
  } catch {
    return jsonError(502, "proxy_error");
  }

  return upstreamResponse;
}

type ORPCContext = RequestHeadersPluginContext & {
  env: ProxyWorkerEnv;
};

const baseProcedure = os.$context<ORPCContext>();

const authProcedure = baseProcedure.use(async ({ context, next }) => {
  const expectedToken = context.env.INGRESS_PROXY_API_TOKEN;
  const providedToken = readBearerToken(context.reqHeaders?.get("authorization") ?? null);

  if (!providedToken || providedToken !== expectedToken) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Missing or invalid Authorization header",
    });
  }

  return next();
});

const PatternInput = z.object({
  pattern: z.string().min(1),
  target: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const CreateRouteInput = z.object({
  patterns: z.array(PatternInput).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateRouteInput = z.object({
  routeId: z.string().min(1),
  patterns: z.array(PatternInput).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const RouteIdInput = z.object({
  routeId: z.string().min(1),
});

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function mapRouteError(error: unknown): never {
  if (error instanceof RouteInputError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }

  if (error instanceof RouteConflictError) {
    throw new ORPCError("CONFLICT", {
      message:
        "Pattern conflicts with existing route patterns. Delete conflicting routes or use updateRoute on the existing route.",
      data: {
        conflicts: error.conflicts,
      },
    });
  }

  if (isUniqueConstraintError(error)) {
    throw new ORPCError("CONFLICT", {
      message:
        "Pattern conflicts with existing route patterns. A concurrent request may have claimed the pattern.",
    });
  }

  throw error;
}

export const listRoutesProcedure = authProcedure.handler(async ({ context }) => {
  return listRoutes(context.env.DB);
});

export const getRouteProcedure = authProcedure
  .input(RouteIdInput)
  .handler(async ({ context, input }) => {
    const route = await getRoute(context.env.DB, input.routeId);
    if (!route) {
      throw new ORPCError("NOT_FOUND", { message: "Route not found" });
    }
    return route;
  });

export const createRouteProcedure = authProcedure
  .input(CreateRouteInput)
  .handler(async ({ context, input }) => {
    try {
      return await createRoute(context.env.DB, {
        typeIdPrefix: context.env.TYPEID_PREFIX,
        patterns: input.patterns,
        metadata: input.metadata,
      });
    } catch (error) {
      return mapRouteError(error);
    }
  });

export const updateRouteProcedure = authProcedure
  .input(UpdateRouteInput)
  .handler(async ({ context, input }) => {
    try {
      return await updateRoute(context.env.DB, {
        routeId: input.routeId,
        patterns: input.patterns,
        metadata: input.metadata,
      });
    } catch (error) {
      return mapRouteError(error);
    }
  });

export const deleteRouteProcedure = authProcedure
  .input(RouteIdInput)
  .handler(async ({ context, input }) => {
    try {
      const deleted = await deleteRoute(context.env.DB, input.routeId);
      return { deleted };
    } catch (error) {
      return mapRouteError(error);
    }
  });

export const appRouter = {
  listRoutes: listRoutesProcedure,
  getRoute: getRouteProcedure,
  createRoute: createRouteProcedure,
  updateRoute: updateRouteProcedure,
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

export const app = new Hono<{
  Bindings: RawProxyWorkerEnv;
  Variables: {
    env: ProxyWorkerEnv;
  };
}>();

app.use("*", async (c, next) => {
  c.set("env", parseWorkerEnv(c.env));
  return next();
});

app.get("/health", () => new Response("OK", { status: 200 }));

app.all("/api/orpc/*", async (c) => {
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: {
      env: c.var.env,
    },
  });

  if (!matched) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.newResponse(response.body, response);
});

app.all("*", async (c) => {
  return proxyRequest(c.req.raw, c.var.env);
});

export default app;
