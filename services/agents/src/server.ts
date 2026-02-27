import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
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
import {
  AGENTS_PROMPT_ADDED_TYPE,
  type SlackReplyTarget,
} from "../../../packages/shared/src/jonasland/agents-events.ts";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";

interface AgentRecord {
  path: string;
  destination: string | null;
  isWorking: boolean;
  shortStatus: string;
  createdAt: string;
  updatedAt: string;
}

const agents = new Map<string, AgentRecord>();
const subscriptions = new Map<string, Set<string>>();
const inFlightAgentCreations = new Map<string, Promise<AgentRecord>>();

const env = agentsServiceManifest.envVars.parse(process.env);
const port = env.AGENTS_SERVICE_PORT;
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
    getOrCreate: docsOs.agents.getOrCreate.handler(async ({ input }) => ({
      agent: {
        path: input.agentPath,
        destination: null,
        isWorking: false,
        shortStatus: "",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      wasNewlyCreated: false,
    })),
    update: docsOs.agents.update.handler(async ({ input }) => ({
      ok: true,
      agent: {
        path: input.path,
        destination: input.destination ?? null,
        isWorking: input.isWorking ?? false,
        shortStatus: input.shortStatus ?? "",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    })),
    subscribe: docsOs.agents.subscribe.handler(async () => ({
      ok: true,
    })),
    slackProxy: docsOs.agents.slackProxy.handler(async ({ input }) => ({
      ok: true,
      created: false,
      sessionId: `stub-${input.threadTs}`,
      streamPath: `/agents/opencode/stub-${input.threadTs}`,
    })),
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

for (const path of ["/api/openapi.json", "/api/docs", "/api/docs/*"]) {
  app.all(path, async (c) => {
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

interface AgentRouteRecord {
  sourceKind: "slack_thread";
  sourceId: string;
  provider: "opencode";
  sessionId: string;
  streamPath: string;
  createdAt: string;
  updatedAt: string;
}

function normalizeStreamPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function toCanonicalAgentStreamPath(sessionId: string): string {
  return `/agents/opencode/${sessionId}`;
}

function encodeStreamPathForUrl(path: string): string {
  const normalized = normalizeStreamPath(path);
  return normalized
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toEventsApiUrl(pathname: string): string {
  return new URL(pathname, env.EVENTS_SERVICE_BASE_URL).toString();
}

function buildSubscriptionSlug(threadTs: string): string {
  return `slack-thread-${threadTs.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function providerSubscriptionSlug(sessionId: string): string {
  return `provider-opencode-${sessionId}`;
}

function virtualSlackAgentPath(threadTs: string): string {
  return `/agents/slack/${threadTs.replace(/\./g, "-")}`;
}

function parseSessionId(payload: { route?: string; sessionId?: string }): string {
  if (payload.sessionId && payload.sessionId.trim().length > 0) {
    return payload.sessionId.trim();
  }

  const route = payload.route?.trim();
  if (!route) {
    throw new Error("opencode-wrapper session response missing sessionId");
  }

  const last = route
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1);
  if (!last) throw new Error("opencode-wrapper session route missing id");
  return last;
}

function readRouteBySlackThread(threadTs: string): AgentRouteRecord | null {
  const row = agentsDb
    .prepare(
      `SELECT source_kind, source_id, provider, session_id, stream_path, created_at, updated_at
       FROM agent_routes
       WHERE source_kind = ? AND source_id = ?
       LIMIT 1`,
    )
    .get("slack_thread", threadTs) as
    | {
        source_kind: string;
        source_id: string;
        provider: string;
        session_id: string;
        stream_path: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;
  return {
    sourceKind: "slack_thread",
    sourceId: row.source_id,
    provider: "opencode",
    sessionId: row.session_id,
    streamPath: row.stream_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertRoute(params: {
  threadTs: string;
  sessionId: string;
  streamPath: string;
}): AgentRouteRecord {
  const now = nowIso();
  agentsDb
    .prepare(
      `INSERT INTO agent_routes (source_kind, source_id, provider, session_id, stream_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "slack_thread",
      params.threadTs,
      "opencode",
      params.sessionId,
      params.streamPath,
      now,
      now,
    );

  return {
    sourceKind: "slack_thread",
    sourceId: params.threadTs,
    provider: "opencode",
    sessionId: params.sessionId,
    streamPath: params.streamPath,
    createdAt: now,
    updatedAt: now,
  };
}

async function appendEventToStream(params: {
  streamPath: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const encodedPath = encodeStreamPathForUrl(params.streamPath);
  const response = await fetch(toEventsApiUrl(`/api/streams/${encodedPath}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          type: params.type,
          payload: params.payload,
          ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`events append failed: ${response.status} ${await response.text()}`);
  }
}

async function registerPushSubscription(params: {
  streamPath: string;
  subscription: {
    type: "webhook" | "webhook-with-ack";
    URL: string;
    subscriptionSlug: string;
  };
  idempotencyKey?: string;
}) {
  const response = await fetch(toEventsApiUrl("/orpc/registerSubscription"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: {
        path: normalizeStreamPath(params.streamPath),
        subscription: params.subscription,
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `events registerSubscription failed: ${response.status} ${await response.text()}`,
    );
  }
}

function routeToAbsolute(baseUrl: string, destination: string): string {
  if (destination.startsWith("http://") || destination.startsWith("https://")) return destination;
  return `${baseUrl}${destination.startsWith("/") ? destination : `/${destination}`}`;
}

function pruneSubscription(agentPath: string, callbackUrl: string): void {
  const urls = subscriptions.get(agentPath);
  if (!urls) return;
  urls.delete(callbackUrl);
  if (urls.size === 0) {
    subscriptions.delete(agentPath);
  }
}

async function createDestination(agentPath: string): Promise<string> {
  const response = await fetch(`${env.OPENCODE_WRAPPER_BASE_URL}/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPath }),
  });

  if (!response.ok) {
    throw new Error(`opencode-wrapper create failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { route: string };
  return routeToAbsolute(env.OPENCODE_WRAPPER_BASE_URL, payload.route);
}

async function getOrCreateSlackThreadRoute(threadTs: string): Promise<{
  route: AgentRouteRecord;
  created: boolean;
}> {
  const existing = readRouteBySlackThread(threadTs);
  if (existing) return { route: existing, created: false };

  const response = await fetch(`${env.OPENCODE_WRAPPER_BASE_URL}/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPath: virtualSlackAgentPath(threadTs) }),
  });

  if (!response.ok) {
    throw new Error(`opencode-wrapper create failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { route?: string; sessionId?: string };
  const sessionId = parseSessionId(payload);
  const streamPath = toCanonicalAgentStreamPath(sessionId);

  try {
    const inserted = insertRoute({ threadTs, sessionId, streamPath });
    return { route: inserted, created: true };
  } catch {
    const raced = readRouteBySlackThread(threadTs);
    if (!raced) throw new Error("failed to resolve slack thread route");
    return { route: raced, created: false };
  }
}

function createAgentRecord(agentPath: string, destination: string): AgentRecord {
  const createdAt = nowIso();
  return {
    path: agentPath,
    destination,
    isWorking: false,
    shortStatus: "",
    createdAt,
    updatedAt: createdAt,
  };
}

async function getOrCreateAgentRecord(
  agentPath: string,
): Promise<{ agent: AgentRecord; wasNewlyCreated: boolean }> {
  const existing = agents.get(agentPath);
  if (existing) {
    return { agent: existing, wasNewlyCreated: false };
  }

  let pending = inFlightAgentCreations.get(agentPath);
  if (!pending) {
    pending = (async () => {
      const destination = await createDestination(agentPath);
      const created = createAgentRecord(agentPath, destination);
      agents.set(agentPath, created);
      return created;
    })();
    inFlightAgentCreations.set(agentPath, pending);
    void pending
      .finally(() => {
        if (inFlightAgentCreations.get(agentPath) === pending) {
          inFlightAgentCreations.delete(agentPath);
        }
      })
      .catch(() => {});

    const created = await pending;
    return { agent: created, wasNewlyCreated: true };
  }

  const resolved = await pending;
  return { agent: resolved, wasNewlyCreated: false };
}

app.post("/api/agents/get-or-create", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string };
  const agentPath = body.agentPath?.trim();
  if (!agentPath) return c.json({ error: "agentPath is required" }, 400);

  const { agent, wasNewlyCreated } = await getOrCreateAgentRecord(agentPath);
  return c.json({ agent, wasNewlyCreated });
});

app.post("/api/agents/update", async (c) => {
  const body = (await c.req.json()) as {
    path?: string;
    destination?: string | null;
    isWorking?: boolean;
    shortStatus?: string;
  };

  const path = body.path?.trim();
  if (!path) return c.json({ error: "path is required" }, 400);

  const existing = agents.get(path);
  if (!existing) return c.json({ error: "agent not found" }, 404);

  const updated: AgentRecord = {
    ...existing,
    ...(body.destination !== undefined ? { destination: body.destination } : {}),
    ...(body.isWorking !== undefined ? { isWorking: body.isWorking } : {}),
    ...(body.shortStatus !== undefined ? { shortStatus: body.shortStatus } : {}),
    updatedAt: nowIso(),
  };

  agents.set(path, updated);

  const callbackUrls = subscriptions.get(path) ?? new Set<string>();
  const callbackBody = JSON.stringify({
    type: "iterate:agent-updated",
    payload: updated,
  });
  for (const callbackUrl of callbackUrls) {
    void fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: callbackBody,
    })
      .then((response) => {
        if (!response.ok) {
          pruneSubscription(path, callbackUrl);
        }
      })
      .catch(() => {
        pruneSubscription(path, callbackUrl);
      });
  }

  return c.json({ ok: true as const, agent: updated });
});

app.post("/api/agents/subscribe", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string; callbackUrl?: string };
  const agentPath = body.agentPath?.trim();
  const callbackUrl = body.callbackUrl?.trim();
  if (!agentPath || !callbackUrl) {
    return c.json({ error: "agentPath and callbackUrl are required" }, 400);
  }

  let urls = subscriptions.get(agentPath);
  if (!urls) {
    urls = new Set<string>();
    subscriptions.set(agentPath, urls);
  }
  urls.add(callbackUrl);

  return c.json({ ok: true as const });
});

app.post("/api/agents/unsubscribe", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string; callbackUrl?: string };
  const agentPath = body.agentPath?.trim();
  const callbackUrl = body.callbackUrl?.trim();
  if (!agentPath || !callbackUrl) {
    return c.json({ error: "agentPath and callbackUrl are required" }, 400);
  }

  pruneSubscription(agentPath, callbackUrl);
  return c.json({ ok: true as const });
});

async function handleSlackProxy(c: {
  req: { param: (name: string) => string; json: () => Promise<unknown> };
  json: (body: unknown, status?: number) => Response;
}) {
  const threadTs = c.req.param("threadTs")?.trim();
  if (!threadTs) return c.json({ error: "threadTs is required" }, 400);

  const body = (await c.req.json()) as {
    prompt?: string;
    slack?: {
      channel?: string;
      threadTs?: string;
      ts?: string;
      user?: string;
      subtype?: string;
    };
    callbackUrl?: string;
    idempotencyKey?: string;
  };

  const prompt = body.prompt?.trim();
  const channel = body.slack?.channel?.trim();
  const callbackUrl = body.callbackUrl?.trim();
  if (!prompt || !channel || !callbackUrl) {
    return c.json({ error: "prompt, slack.channel, and callbackUrl are required" }, 400);
  }

  const slackReplyTarget: SlackReplyTarget = {
    channel,
    threadTs,
  };

  const { route, created } = await getOrCreateSlackThreadRoute(threadTs);

  await registerPushSubscription({
    streamPath: route.streamPath,
    subscription: {
      type: "webhook-with-ack",
      URL: `${env.OPENCODE_WRAPPER_BASE_URL}/internal/events/provider`,
      subscriptionSlug: providerSubscriptionSlug(route.sessionId),
    },
    idempotencyKey: `subscription:provider:${route.streamPath}`,
  });

  await registerPushSubscription({
    streamPath: route.streamPath,
    subscription: {
      type: "webhook",
      URL: callbackUrl,
      subscriptionSlug: buildSubscriptionSlug(threadTs),
    },
    idempotencyKey: `subscription:slack:${route.streamPath}:${threadTs}`,
  });

  await appendEventToStream({
    streamPath: route.streamPath,
    type: AGENTS_PROMPT_ADDED_TYPE,
    payload: {
      prompt,
      source: "slack",
      virtualAgentPath: virtualSlackAgentPath(threadTs),
      replyTarget: slackReplyTarget,
    },
    idempotencyKey: body.idempotencyKey ?? `prompt:${threadTs}:${body.slack?.ts ?? prompt}`,
  });

  return c.json({
    ok: true as const,
    created,
    sessionId: route.sessionId,
    streamPath: route.streamPath,
  });
}

app.post("/api/agents/slack/:threadTs/proxy", handleSlackProxy);
app.post("/agents/slack/:threadTs/proxy", handleSlackProxy);

app.post("/api/agents/forward/*", async (c) => {
  const suffix = c.req.path.slice("/api/agents/forward".length);
  const agentPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (agentPath === "/") return c.json({ error: "agent path missing" }, 400);

  const { agent } = await getOrCreateAgentRecord(agentPath);

  if (!agent.destination) {
    return c.json({ error: "agent destination unavailable" }, 503);
  }

  const body = await c.req.json();
  const upstream = await fetch(agent.destination, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-iterate-agent-path": agentPath,
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  c.header("content-type", upstream.headers.get("content-type") ?? "application/json");
  c.status(upstream.status as never);
  return c.body(text);
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
