import { Hono } from "hono";
import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, type RequestHeadersPluginContext } from "@orpc/server/plugins";
import { typeid } from "typeid-js";
import { z } from "zod/v4";
import {
  MAX_PATTERN_LENGTH,
  normalizeExternalId,
  normalizePattern,
  normalizeRouteId,
  RouteInputError,
} from "./route-conflicts.ts";
import {
  deleteRouteByExternalId,
  deleteRouteById,
  deleteRoutePatternsByRouteIdStmt,
  insertRoutePatternStmt,
  insertRouteStmt,
  selectRouteById,
  selectRoutePatterns,
  selectRoutePatternsByRouteId,
  selectRoutes,
  updateRouteByIdStmt,
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
  externalId: string | null;
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
  external_id?: string;
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

type ForwardedProto = "http" | "https" | "ws" | "wss";

const forwardingContextHeaderPrefixes = ["x-forwarded-"] as const;
const forwardingContextHeaderNames = new Set([
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
]);

const parsedEnvCache = new WeakMap<RawProxyWorkerEnv, ProxyWorkerEnv>();

function getParsedEnv(env: RawProxyWorkerEnv): ProxyWorkerEnv {
  const cached = parsedEnvCache.get(env);
  if (cached) return cached;

  const parsed = parseWorkerEnv(env);
  parsedEnvCache.set(env, parsed);
  return parsed;
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

function firstHeaderToken(rawHeader: string | null | undefined): string | null {
  if (!rawHeader) return null;
  const token = rawHeader.split(",")[0]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function isForwardingContextHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  if (forwardingContextHeaderNames.has(lowered)) return true;
  if (forwardingContextHeaderPrefixes.some((prefix) => lowered.startsWith(prefix))) return true;
  return lowered.startsWith("x-") && lowered.includes("-original-");
}

function stripForwardingContextHeaders(headers: Headers): void {
  for (const headerName of [...headers.keys()]) {
    if (isForwardingContextHeader(headerName)) {
      headers.delete(headerName);
    }
  }
}

function resolveOriginalRequestHost(request: Request): string {
  return firstHeaderToken(request.headers.get("host")) ?? new URL(request.url).host;
}

function resolveClientIp(request: Request): string | null {
  return (
    firstHeaderToken(request.headers.get("cf-connecting-ip")) ??
    firstHeaderToken(request.headers.get("true-client-ip")) ??
    firstHeaderToken(request.headers.get("x-real-ip"))
  );
}

function normalizeForwardedProto(proto: string | undefined, request: Request): ForwardedProto {
  const normalized = proto?.trim().toLowerCase();
  const isWebsocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const requestProto = new URL(request.url).protocol === "https:" ? "https" : "http";

  if (isWebsocket) {
    if (normalized === "wss" || normalized === "https") return "wss";
    if (normalized === "ws" || normalized === "http") return "ws";
    return requestProto === "https" ? "wss" : "ws";
  }

  if (normalized === "https" || normalized === "wss") return "https";
  if (normalized === "http" || normalized === "ws") return "http";
  return requestProto;
}

function resolveForwardingContext(request: Request): {
  host: string;
  proto: ForwardedProto;
  forValue: string | null;
} {
  return {
    host: resolveOriginalRequestHost(request),
    proto: normalizeForwardedProto(undefined, request),
    forValue: resolveClientIp(request),
  };
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexPattern}$`).test(host);
}

function comparePatternSpecificity(
  a: { pattern: string; id: number },
  b: { pattern: string; id: number },
): number {
  const aHasWildcard = a.pattern.includes("*");
  const bHasWildcard = b.pattern.includes("*");
  if (aHasWildcard !== bHasWildcard) {
    return aHasWildcard ? 1 : -1;
  }
  const lengthDelta = b.pattern.length - a.pattern.length;
  if (lengthDelta !== 0) return lengthDelta;
  return a.id - b.id;
}

function parseTargetUrl(target: string): URL {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new RouteInputError("target must be a valid URL");
  }

  if (/^[/?#.]/.test(trimmed)) {
    throw new RouteInputError("target must be a valid URL");
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^(https?|wss?):/i.test(trimmed)
      ? trimmed.replace(/^([a-z][a-z\d+.-]*):/i, "$1://")
      : `https://${trimmed}`;

  const normalizedInput = withScheme
    .replace(/^ws:\/\//i, "http://")
    .replace(/^wss:\/\//i, "https://");

  let parsed: URL;
  try {
    parsed = new URL(normalizedInput);
  } catch {
    throw new RouteInputError("target must be a valid URL");
  }

  if (!parsed.hostname) {
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

function normalizeOptionalExternalId(externalId: string | null | undefined): string | null {
  if (externalId == null) return null;
  return normalizeExternalId(externalId);
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
    externalId: row.external_id ?? null,
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
  const routeRows = await selectRouteById(db, { routeId: normalizedRouteId });
  const patterns = await selectRoutePatternsByRouteId(db, { routeId: normalizedRouteId });

  return {
    route: routeRows[0] ?? null,
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
    externalId?: string | null;
  },
): Promise<RouteRecord> {
  const normalizedPatterns = normalizePatternInputs(params.patterns);

  const routeId = typeid(params.typeIdPrefix).toString();
  const metadata = normalizeMetadata(params.metadata);
  const externalId = normalizeOptionalExternalId(params.externalId);

  await db.batch([
    insertRouteStmt(db, { routeId, externalId, metadata: JSON.stringify(metadata) }),
    ...normalizedPatterns.map((pattern) => {
      return insertRoutePatternStmt(db, {
        routeId,
        pattern: pattern.pattern,
        target: pattern.target,
        headers: JSON.stringify(pattern.headers),
      });
    }),
  ]);

  const created = await getRoute(db, routeId);
  if (!created) throw new Error("Failed to read route after create");
  return created;
}

export async function updateRoute(
  db: D1Database,
  params: {
    routeId: string;
    patterns: Array<{ pattern: string; target: string; headers?: RouteHeaders }>;
    metadata: RouteMetadata;
    externalId?: string | null;
  },
): Promise<RouteRecord> {
  const routeId = normalizeRouteId(params.routeId);
  const existing = await getRoute(db, routeId);
  if (!existing) {
    throw new ORPCError("NOT_FOUND", { message: "Route not found" });
  }

  const normalizedPatterns = normalizePatternInputs(params.patterns);
  const externalId =
    params.externalId === undefined
      ? existing.externalId
      : normalizeOptionalExternalId(params.externalId);
  await db.batch([
    updateRouteByIdStmt(db, { metadata: JSON.stringify(params.metadata), externalId }, { routeId }),
    deleteRoutePatternsByRouteIdStmt(db, { routeId }),
    ...normalizedPatterns.map((pattern) => {
      return insertRoutePatternStmt(db, {
        routeId,
        pattern: pattern.pattern,
        target: pattern.target,
        headers: JSON.stringify(pattern.headers),
      });
    }),
  ]);

  const updated = await getRoute(db, routeId);
  if (!updated) throw new Error("Failed to read route after update");
  return updated;
}

type DeleteRouteParams =
  | { routeId: string; externalId?: never }
  | { routeId?: never; externalId: string };

export async function deleteRoute(db: D1Database, params: DeleteRouteParams): Promise<boolean> {
  if (params.routeId !== undefined) {
    const normalizedRouteId = normalizeRouteId(params.routeId);
    const result = await deleteRouteById(db, { routeId: normalizedRouteId });
    return (result.changes ?? 0) > 0;
  }

  const normalizedExternalId = normalizeExternalId(params.externalId);
  const result = await deleteRouteByExternalId(db, { externalId: normalizedExternalId });
  return (result.changes ?? 0) > 0;
}

export async function resolveRoute(
  db: D1Database,
  request: Request,
): Promise<ResolvedRoute | null> {
  return resolveRouteByHost(db, request.headers.get("host"));
}

export async function resolveRouteByHost(
  db: D1Database,
  rawHost: string | null,
): Promise<ResolvedRoute | null> {
  const host = normalizeInboundHost(rawHost);
  if (!host) return null;

  const patterns = await selectRoutePatterns(db);
  const winnerPattern = patterns
    .filter((row) => hostMatchesPattern(host, row.pattern))
    .sort(comparePatternSpecificity)[0];
  if (!winnerPattern) return null;

  const routeRows = await selectRouteById(db, { routeId: winnerPattern.route_id });
  const route = routeRows[0];
  if (!route) return null;

  return {
    routeId: winnerPattern.route_id,
    pattern: winnerPattern.pattern,
    targetUrl: parseTargetUrl(winnerPattern.target),
    headers: parseJsonObject(winnerPattern.headers, "headers") as RouteHeaders,
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

export function createUpstreamHeaders(
  request: Request,
  routeHeaders: RouteHeaders,
  targetUrl: URL,
): Headers {
  const headers = new Headers(request.headers);
  const forwardingContext = resolveForwardingContext(request);
  stripForwardingContextHeaders(headers);
  for (const [name, value] of Object.entries(routeHeaders)) {
    headers.set(name, value);
  }

  // The worker owns proxy transport/forwarding headers. Route headers can add
  // metadata, but they do not control Host or X-Forwarded-* semantics.
  stripForwardingContextHeaders(headers);
  headers.set("host", targetUrl.host);
  headers.set("x-forwarded-host", forwardingContext.host);
  headers.set("x-forwarded-proto", forwardingContext.proto);
  if (forwardingContext.forValue) {
    headers.set("x-forwarded-for", forwardingContext.forValue);
    headers.set("x-real-ip", forwardingContext.forValue);
    headers.set("cf-connecting-ip", forwardingContext.forValue);
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
  const upstreamHeaders = createUpstreamHeaders(
    upstreamRequest,
    resolved.headers,
    resolved.targetUrl,
  );
  upstreamRequest = new Request(upstreamRequest, { headers: upstreamHeaders });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest, { redirect: "manual" });
  } catch {
    return jsonError(502, "proxy_error");
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("x-cf-proxy-route", resolved.routeId);

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

const OptionalExternalIdInput = z.string().min(1).nullable().optional();

const CreateRouteInput = z.object({
  patterns: z.array(PatternInput).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  externalId: OptionalExternalIdInput,
});

const UpdateRouteInput = z.object({
  routeId: z.string().min(1),
  patterns: z.array(PatternInput).min(1),
  metadata: z.record(z.string(), z.unknown()),
  externalId: OptionalExternalIdInput,
});

const RouteIdInput = z.object({
  routeId: z.string().min(1),
});

const DeleteRouteInput = z
  .object({
    routeId: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (!!input.routeId === !!input.externalId) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of routeId or externalId",
      });
    }
  });

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function isForeignKeyConstraintError(error: unknown): boolean {
  return error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);
}

function mapRouteError(error: unknown): never {
  if (error instanceof ORPCError) {
    throw error;
  }

  if (error instanceof RouteInputError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }

  if (isForeignKeyConstraintError(error)) {
    throw new ORPCError("NOT_FOUND", { message: "Route not found" });
  }

  if (isUniqueConstraintError(error)) {
    if (error instanceof Error && /routes\.external_id/i.test(error.message)) {
      throw new ORPCError("CONFLICT", {
        message: "externalId conflicts with an existing route.",
      });
    }

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
        externalId: input.externalId,
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
        externalId: input.externalId,
      });
    } catch (error) {
      return mapRouteError(error);
    }
  });

export const deleteRouteProcedure = authProcedure
  .input(DeleteRouteInput)
  .handler(async ({ context, input }) => {
    try {
      const deleted = input.routeId
        ? await deleteRoute(context.env.DB, { routeId: input.routeId })
        : await deleteRoute(context.env.DB, { externalId: input.externalId! });
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
}>();

app.get("/health", (c) => c.text("OK"));

app.all("/api/orpc/*", async (c) => {
  const parsedEnv = getParsedEnv(c.env);
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: {
      env: parsedEnv,
    },
  });

  if (!matched) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.newResponse(response.body, response);
});

app.all("*", async (c) => {
  const parsedEnv = getParsedEnv(c.env);
  return proxyRequest(c.req.raw, parsedEnv);
});

export default app;
