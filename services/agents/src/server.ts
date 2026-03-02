import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { agentsServiceManifest } from "@iterate-com/agents-contract";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import BetterSqlite3 from "better-sqlite3";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateBetterSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { Hono } from "hono";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";

interface AgentProvisioningRecord {
  agentPath: string;
  provider: AgentProvider;
  sessionId: string;
  streamPath: string;
  createdAt: string;
  updatedAt: string;
}

type AgentProvider = "opencode" | "pi";

const inFlightGetOrCreate = new Map<string, Promise<AgentProvisioningRecord>>();

const env = agentsServiceManifest.envVars.parse(process.env);
const port = env.AGENTS_SERVICE_PORT;
const defaultAgentProvider = env.AGENTS_DEFAULT_PROVIDER;
const serviceRegistryHost = "agents.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";
const MIGRATIONS_FOLDER = path.resolve(fileURLToPath(new URL("../drizzle", import.meta.url)));

const ensureSqliteDirectory = (filename: string): void => {
  if (filename === ":memory:") return;
  if (filename.startsWith("file:")) return;

  const directory = path.dirname(filename);
  if (directory === "." || directory === "") return;
  mkdirSync(directory, { recursive: true });
};

ensureSqliteDirectory(env.AGENTS_SERVICE_DB_PATH);
const agentsDb = new BetterSqlite3(env.AGENTS_SERVICE_DB_PATH);
migrateBetterSqlite(drizzleBetterSqlite(agentsDb), {
  migrationsFolder: MIGRATIONS_FOLDER,
});

const app = new Hono();
const docsOs = implement(agentsServiceManifest.orpcContract);
const docsRouter = docsOs.router({
  service: {
    health: docsOs.service.health.handler(async () => ({
      ok: true,
      service: agentsServiceManifest.name,
      version: agentsServiceManifest.version,
    })),
    sql: docsOs.service.sql.handler(async () => ({
      rows: [],
      headers: [],
      stat: {
        rowsAffected: 0,
        rowsRead: null,
        rowsWritten: null,
        queryDurationMs: 0,
      },
    })),
  },
  agents: {
    getOrCreate: docsOs.agents.getOrCreate.handler(async ({ input }) => {
      const provider = normalizeProvider(input.provider ?? defaultAgentProvider);
      return {
        agent: {
          agentPath: input.agentPath,
          provider,
          sessionId: "stub-session",
          streamPath: `/agents/${provider}/stub-session`,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        wasNewlyCreated: false,
      };
    }),
    appendToStream: docsOs.agents.appendToStream.handler(async () => undefined),
    registerStreamSubscription: docsOs.agents.registerStreamSubscription.handler(
      async () => undefined,
    ),
    ackStreamSubscriptionOffset: docsOs.agents.ackStreamSubscriptionOffset.handler(
      async () => undefined,
    ),
    stream: docsOs.agents.stream.handler(async function* () {
      return;
    }),
  },
});

const openAPIHandler = new OpenAPIHandler(docsRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "jonasland agents-service API",
          version: agentsServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

app.get("/healthz", (c) => c.text("ok"));
mountServiceSubRouterHttpRoutes({ app, manifest: agentsServiceManifest });

for (const docPath of ["/api/openapi.json", "/api/docs", "/api/docs/*"]) {
  app.all(docPath, async (c) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
    });
    if (matched) return c.newResponse(response.body, response);
    return c.json({ error: "not_found" }, 404);
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerOpenApiRoute(): Promise<void> {
  const servicesClient = createRegistryClient({ url: env.SERVICES_ORPC_URL });
  const routeTarget = `127.0.0.1:${String(port)}`;

  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      await servicesClient.routes.upsert({
        host: serviceRegistryHost,
        target: routeTarget,
        metadata: {
          openapiPath: serviceRegistryOpenApiPath,
          title: "Agents Service",
        },
        tags: ["openapi", "agents"],
      });
      return;
    } catch {
      await delay(1_000);
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAgentPath(agentPath: string): string {
  const trimmed = agentPath.trim();
  if (trimmed.length === 0) {
    throw new Error("agentPath is required");
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeProvider(provider: unknown): AgentProvider {
  return provider === "pi" ? "pi" : "opencode";
}

function normalizeStreamPath(streamPath: string): string {
  const trimmed = streamPath.trim();
  if (trimmed.length === 0) {
    throw new Error("streamPath is required");
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function encodeStreamPathForUrl(streamPath: string): string {
  return streamPath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeWildcardPath(pathname: string): string {
  const decoded = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
    .join("/");
  return `/${decoded}`;
}

function toEventsApiUrl(pathname: string): string {
  return new URL(pathname, env.EVENTS_SERVICE_BASE_URL).toString();
}

function toCanonicalProviderStreamPath(provider: AgentProvider, sessionId: string): string {
  return `/agents/${provider}/${sessionId}`;
}

function providerWrapperBaseUrl(provider: AgentProvider): string {
  return provider === "pi" ? env.PI_WRAPPER_BASE_URL : env.OPENCODE_WRAPPER_BASE_URL;
}

function readProvisionByAgentPath(agentPath: string): AgentProvisioningRecord | null {
  const row = agentsDb
    .prepare(
      `SELECT agent_path, provider, session_id, stream_path, created_at, updated_at
       FROM agent_provisioning
       WHERE agent_path = ?
       LIMIT 1`,
    )
    .get(agentPath) as
    | {
        agent_path: string;
        provider: string;
        session_id: string;
        stream_path: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;
  return {
    agentPath: row.agent_path,
    provider: normalizeProvider(row.provider),
    sessionId: row.session_id,
    streamPath: row.stream_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertProvisioning(params: {
  agentPath: string;
  provider: AgentProvider;
  sessionId: string;
  streamPath: string;
}): AgentProvisioningRecord {
  const now = nowIso();
  agentsDb
    .prepare(
      `INSERT INTO agent_provisioning (agent_path, provider, session_id, stream_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_path)
       DO UPDATE SET
         provider = excluded.provider,
         session_id = excluded.session_id,
         stream_path = excluded.stream_path,
         updated_at = excluded.updated_at`,
    )
    .run(params.agentPath, params.provider, params.sessionId, params.streamPath, now, now);

  return {
    agentPath: params.agentPath,
    provider: params.provider,
    sessionId: params.sessionId,
    streamPath: params.streamPath,
    createdAt: now,
    updatedAt: now,
  };
}

async function createProviderSession(
  provider: AgentProvider,
  agentPath: string,
): Promise<{ sessionId: string; streamPath: string }> {
  const response = await fetch(`${providerWrapperBaseUrl(provider)}/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPath }),
  });

  if (!response.ok) {
    throw new Error(
      `${provider}-wrapper create failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    route?: string;
    sessionId?: string;
    streamPath?: string;
  };

  const sessionId = payload.sessionId?.trim();
  if (!sessionId) {
    throw new Error(`${provider}-wrapper session response missing sessionId`);
  }

  const streamPath = payload.streamPath?.trim();
  return {
    sessionId,
    streamPath: normalizeStreamPath(
      streamPath ?? toCanonicalProviderStreamPath(provider, sessionId),
    ),
  };
}

async function getOrCreateAgentProvisioning(input: {
  agentPath: string;
  provider: AgentProvider;
}): Promise<{ agent: AgentProvisioningRecord; wasNewlyCreated: boolean }> {
  const agentPath = normalizeAgentPath(input.agentPath);
  const provider = input.provider;
  const inFlightKey = `${provider}:${agentPath}`;
  const existing = readProvisionByAgentPath(agentPath);
  if (existing && existing.provider === provider) {
    return { agent: existing, wasNewlyCreated: false };
  }

  let pending = inFlightGetOrCreate.get(inFlightKey);
  if (!pending) {
    pending = (async () => {
      const createdSession = await createProviderSession(provider, agentPath);
      return insertProvisioning({
        agentPath,
        provider,
        sessionId: createdSession.sessionId,
        streamPath: createdSession.streamPath,
      });
    })();

    inFlightGetOrCreate.set(inFlightKey, pending);
    void pending
      .finally(() => {
        if (inFlightGetOrCreate.get(inFlightKey) === pending) {
          inFlightGetOrCreate.delete(inFlightKey);
        }
      })
      .catch(() => {});

    const created = await pending;
    return { agent: created, wasNewlyCreated: true };
  }

  const resolved = await pending;
  return { agent: resolved, wasNewlyCreated: false };
}

async function resolveTargetStreamPath(proxyPath: string): Promise<string> {
  const canonicalProxyPath = normalizeAgentPath(proxyPath);

  if (
    canonicalProxyPath.startsWith("/agents/opencode/") ||
    canonicalProxyPath.startsWith("/agents/pi/")
  ) {
    return canonicalProxyPath;
  }

  const record = readProvisionByAgentPath(canonicalProxyPath);
  if (!record) {
    throw new Error(`agent stream target not found: ${canonicalProxyPath}`);
  }

  return record.streamPath;
}

async function proxyAppend(streamPath: string, body: unknown): Promise<Response> {
  const payload = body as {
    events?: Array<{
      type?: string;
      payload?: unknown;
      version?: string;
      idempotencyKey?: string;
    }>;
  };

  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    return new Response(JSON.stringify({ error: "events array is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encodedPath = encodeStreamPathForUrl(streamPath);
  return fetch(toEventsApiUrl(`/api/streams/${encodedPath}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: payload.events }),
  });
}

async function proxyRegisterSubscription(streamPath: string, body: unknown): Promise<Response> {
  const payload = body as {
    subscription?: unknown;
    idempotencyKey?: string;
  };

  return fetch(toEventsApiUrl("/orpc/registerSubscription"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: {
        path: streamPath.replace(/^\/+/, ""),
        subscription: payload.subscription,
        ...(payload.idempotencyKey ? { idempotencyKey: payload.idempotencyKey } : {}),
      },
    }),
  });
}

async function proxyAckOffset(
  streamPath: string,
  subscriptionSlug: string,
  body: unknown,
): Promise<Response> {
  const payload = body as { offset?: string };
  if (!payload.offset || payload.offset.trim().length === 0) {
    return new Response(JSON.stringify({ error: "offset is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  return fetch(toEventsApiUrl("/orpc/ackOffset"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: {
        path: streamPath.replace(/^\/+/, ""),
        subscriptionSlug,
        offset: payload.offset,
      },
    }),
  });
}

async function proxyReadStream(streamPath: string, search: string): Promise<Response> {
  const encodedPath = encodeStreamPathForUrl(streamPath);
  return fetch(toEventsApiUrl(`/api/streams/${encodedPath}${search}`), {
    method: "GET",
  });
}

app.post("/api/agents/get-or-create", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string; provider?: AgentProvider };
  const agentPath = body.agentPath?.trim();
  if (!agentPath) {
    return c.json({ error: "agentPath is required" }, 400);
  }

  try {
    const requestedProvider = body.provider ?? defaultAgentProvider;
    const { agent, wasNewlyCreated } = await getOrCreateAgentProvisioning({
      agentPath,
      provider: normalizeProvider(requestedProvider),
    });
    return c.json({ agent, wasNewlyCreated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 502);
  }
});

app.all("/api/agents/streams/*", async (c) => {
  const prefix = "/api/agents/streams/";
  const fullPath = c.req.path;
  const suffix = fullPath.slice(prefix.length);

  if (!suffix || suffix.trim().length === 0) {
    return c.json({ error: "path is required" }, 400);
  }

  try {
    if (c.req.method === "POST" && suffix.endsWith("/subscriptions")) {
      const proxyPath = decodeWildcardPath(suffix.slice(0, -"/subscriptions".length));
      const streamPath = await resolveTargetStreamPath(proxyPath);
      const upstream = await proxyRegisterSubscription(
        streamPath,
        await c.req.json().catch(() => ({})),
      );
      const responseBody = await upstream.text();
      c.status(upstream.status as never);
      c.header("content-type", upstream.headers.get("content-type") ?? "application/json");
      return c.body(responseBody);
    }

    const ackMatch = suffix.match(/^(.*)\/subscriptions\/([^/]+)\/ack$/);
    if (c.req.method === "POST" && ackMatch) {
      const proxyPath = decodeWildcardPath(ackMatch[1] ?? "");
      const subscriptionSlug = decodeURIComponent(ackMatch[2] ?? "").trim();
      if (!subscriptionSlug) {
        return c.json({ error: "subscriptionSlug is required" }, 400);
      }

      const streamPath = await resolveTargetStreamPath(proxyPath);
      const upstream = await proxyAckOffset(
        streamPath,
        subscriptionSlug,
        await c.req.json().catch(() => ({})),
      );
      const responseBody = await upstream.text();
      c.status(upstream.status as never);
      c.header("content-type", upstream.headers.get("content-type") ?? "application/json");
      return c.body(responseBody);
    }

    const proxyPath = decodeWildcardPath(suffix);
    const streamPath = await resolveTargetStreamPath(proxyPath);

    if (c.req.method === "POST") {
      const upstream = await proxyAppend(streamPath, await c.req.json().catch(() => ({})));
      const responseBody = await upstream.text();
      c.status(upstream.status as never);
      c.header("content-type", upstream.headers.get("content-type") ?? "application/json");
      return c.body(responseBody);
    }

    if (c.req.method === "GET") {
      const search = new URL(c.req.url).search;
      const upstream = await proxyReadStream(streamPath, search);
      const headers = new Headers(upstream.headers);
      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    }

    return c.json({ error: "method not allowed" }, 405);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 404);
  }
});

export const startAgentsService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
  });

  void registerOpenApiRoute();

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      agentsDb.close();
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startAgentsService();
}
