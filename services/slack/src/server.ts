import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import { slackServiceManifest, type SlackRouteRecord } from "@iterate-com/slack-contract";
import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import BetterSqlite3 from "better-sqlite3";
import { WebSocketServer } from "ws";
import {
  AGENTS_ERROR_TYPE,
  AGENTS_PROMPT_ADDED_TYPE,
  AGENTS_RESPONSE_ADDED_TYPE,
  AGENTS_STATUS_UPDATED_TYPE,
  AgentErrorPayload,
  AgentResponseAddedPayload,
  AgentStatusUpdatedPayload,
  INTEGRATIONS_SLACK_WEBHOOK_RECEIVED_TYPE,
  SlackWebhookReceivedPayload,
} from "../../../packages/shared/src/jonasland/agents-events.ts";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";
import {
  decideSlackWebhook,
  normalizeSlackWebhookInput,
  type SlackWebhookDecision,
} from "./decision.ts";

interface SlackThreadAgentRoute {
  workspaceId: string;
  channel: string;
  threadTs: string;
  agentPath: string;
  providerSessionId: string;
  agentStreamPath: string;
  subscriptionSlug: string;
  createdAt: string;
  updatedAt: string;
}

const env = slackServiceManifest.envVars.parse(process.env);
const app = new Hono();
const INTEGRATIONS_STREAM_PATH = "/integrations/slack/webhooks";
const integrationSubscriptionSlug = "slack-service";
const defaultWorkspaceId = "default";
const serviceRegistryHost = "slack.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";
const docsOs = implement(slackServiceManifest.orpcContract);
const docsRouter = docsOs.router({
  service: {
    health: docsOs.service.health.handler(async () => ({
      ok: true,
      service: slackServiceManifest.name,
      version: slackServiceManifest.version,
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
  slack: {
    webhook: docsOs.slack.webhook.handler(async () => ({
      ok: true,
      queued: true,
      streamPath: INTEGRATIONS_STREAM_PATH,
    })),
    integrationCallback: docsOs.slack.integrationCallback.handler(async () => ({
      ok: true,
      handled: true,
    })),
    decideWebhook: docsOs.slack.decideWebhook.handler(async () => ({
      shouldCreateAgent: true,
      shouldAppendPrompt: true,
      getOrCreateInput: { agentPath: "/agents/slack/demo/demo" },
      reasonCodes: ["stub"],
      debug: {},
    })),
    codemode: docsOs.slack.codemode.handler(async () => ({
      success: true,
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
          title: "jonasland slack-service API",
          version: slackServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

const ensureSqliteDirectory = (filename: string): void => {
  if (filename === ":memory:") return;
  if (filename.startsWith("file:")) return;

  const directory = path.dirname(filename);
  if (directory === "." || directory === "") return;
  mkdirSync(directory, { recursive: true });
};

ensureSqliteDirectory(env.SLACK_SERVICE_DB_PATH);
const db = new BetterSqlite3(env.SLACK_SERVICE_DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS slack_thread_agent_routes (
  workspace_id text NOT NULL,
  channel text NOT NULL,
  thread_ts text NOT NULL,
  agent_path text NOT NULL,
  provider_session_id text NOT NULL,
  agent_stream_path text NOT NULL,
  subscription_slug text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (workspace_id, channel, thread_ts, agent_path)
);

CREATE UNIQUE INDEX IF NOT EXISTS slack_thread_agent_routes_subscription_slug_idx
ON slack_thread_agent_routes (subscription_slug);

CREATE TABLE IF NOT EXISTS slack_outbound_offsets (
  stream_path text NOT NULL,
  offset text NOT NULL,
  delivered_at text NOT NULL,
  PRIMARY KEY (stream_path, offset)
);
`);

const wsServer = new WebSocketServer({ noServer: true });

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSlug(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildOutboundSubscriptionSlug(streamPath: string): string {
  const tail = sanitizeSlug(streamPath);
  return `slack-ws-${tail}`.slice(0, 120);
}

function encodeStreamPathForUrl(pathName: string): string {
  return pathName
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toEventsApiUrl(pathname: string): string {
  return new URL(pathname, env.EVENTS_SERVICE_BASE_URL).toString();
}

function mapRouteRow(row: {
  workspace_id: string;
  channel: string;
  thread_ts: string;
  agent_path: string;
  provider_session_id: string;
  agent_stream_path: string;
  subscription_slug: string;
  created_at: string;
  updated_at: string;
}): SlackThreadAgentRoute {
  return {
    workspaceId: row.workspace_id,
    channel: row.channel,
    threadTs: row.thread_ts,
    agentPath: row.agent_path,
    providerSessionId: row.provider_session_id,
    agentStreamPath: row.agent_stream_path,
    subscriptionSlug: row.subscription_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listRoutesForThread(params: {
  workspaceId: string;
  channel: string;
  threadTs: string;
}): Array<SlackThreadAgentRoute> {
  const rows = db
    .prepare(
      `SELECT workspace_id, channel, thread_ts, agent_path, provider_session_id, agent_stream_path, subscription_slug, created_at, updated_at
       FROM slack_thread_agent_routes
       WHERE workspace_id = ? AND channel = ? AND thread_ts = ?
       ORDER BY created_at ASC`,
    )
    .all(params.workspaceId, params.channel, params.threadTs) as Array<{
    workspace_id: string;
    channel: string;
    thread_ts: string;
    agent_path: string;
    provider_session_id: string;
    agent_stream_path: string;
    subscription_slug: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map(mapRouteRow);
}

function readRouteByAgentPath(agentPath: string): SlackThreadAgentRoute | null {
  const row = db
    .prepare(
      `SELECT workspace_id, channel, thread_ts, agent_path, provider_session_id, agent_stream_path, subscription_slug, created_at, updated_at
       FROM slack_thread_agent_routes
       WHERE agent_path = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(agentPath) as
    | {
        workspace_id: string;
        channel: string;
        thread_ts: string;
        agent_path: string;
        provider_session_id: string;
        agent_stream_path: string;
        subscription_slug: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  return row ? mapRouteRow(row) : null;
}

function readAnyRouteByStreamPath(streamPath: string): SlackThreadAgentRoute | null {
  const row = db
    .prepare(
      `SELECT workspace_id, channel, thread_ts, agent_path, provider_session_id, agent_stream_path, subscription_slug, created_at, updated_at
       FROM slack_thread_agent_routes
       WHERE agent_stream_path = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(streamPath) as
    | {
        workspace_id: string;
        channel: string;
        thread_ts: string;
        agent_path: string;
        provider_session_id: string;
        agent_stream_path: string;
        subscription_slug: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  return row ? mapRouteRow(row) : null;
}

function toSlackContractRoute(route: SlackThreadAgentRoute): SlackRouteRecord {
  return {
    channel: route.channel,
    threadTs: route.threadTs,
    agentPath: route.agentPath,
    providerSessionId: route.providerSessionId,
    agentStreamPath: route.agentStreamPath,
  };
}

function upsertRoute(params: {
  workspaceId: string;
  channel: string;
  threadTs: string;
  agentPath: string;
  providerSessionId: string;
  agentStreamPath: string;
  subscriptionSlug: string;
}): SlackThreadAgentRoute {
  const now = nowIso();
  db.prepare(
    `INSERT INTO slack_thread_agent_routes
      (workspace_id, channel, thread_ts, agent_path, provider_session_id, agent_stream_path, subscription_slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, channel, thread_ts, agent_path)
     DO UPDATE SET
       provider_session_id = excluded.provider_session_id,
       agent_stream_path = excluded.agent_stream_path,
       subscription_slug = excluded.subscription_slug,
       updated_at = excluded.updated_at`,
  ).run(
    params.workspaceId,
    params.channel,
    params.threadTs,
    params.agentPath,
    params.providerSessionId,
    params.agentStreamPath,
    params.subscriptionSlug,
    now,
    now,
  );

  const route = readRouteByAgentPath(params.agentPath);
  if (!route) {
    throw new Error("failed to upsert Slack thread route");
  }
  return route;
}

function rememberOutboundOffset(streamPath: string, offset: string): boolean {
  try {
    db.prepare(
      `INSERT INTO slack_outbound_offsets (stream_path, offset, delivered_at)
       VALUES (?, ?, ?)`,
    ).run(streamPath, offset, nowIso());
    return true;
  } catch {
    return false;
  }
}

function readLatestOutboundOffset(streamPath: string): string | undefined {
  const row = db
    .prepare(
      `SELECT offset
       FROM slack_outbound_offsets
       WHERE stream_path = ?
       ORDER BY offset DESC
       LIMIT 1`,
    )
    .get(streamPath) as { offset: string } | undefined;
  return row?.offset;
}

async function appendIntegrationEvent(params: {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const encodedPath = encodeStreamPathForUrl(INTEGRATIONS_STREAM_PATH);
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

async function appendPromptEvent(params: {
  route: SlackThreadAgentRoute;
  webhook: SlackWebhookReceivedPayload;
  sourcePath: string;
  sourceOffset: string;
}) {
  const encodedPath = encodeStreamPathForUrl(params.route.agentStreamPath);
  const response = await fetch(toEventsApiUrl(`/api/streams/${encodedPath}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          type: AGENTS_PROMPT_ADDED_TYPE,
          payload: {
            prompt: params.webhook.text,
            source: "slack",
            virtualAgentPath: params.route.agentPath,
            replyTarget: {
              channel: params.route.channel,
              threadTs: params.route.threadTs,
            },
          },
          idempotencyKey: `prompt:${params.route.agentPath}:${params.sourcePath}:${params.sourceOffset}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`events append failed: ${response.status} ${await response.text()}`);
  }
}

async function registerSubscription(params: {
  streamPath: string;
  subscription: {
    type: "webhook" | "webhook-with-ack" | "websocket" | "websocket-with-ack";
    URL: string;
    subscriptionSlug: string;
    sendHistoricEventsFromOffset?: string;
  };
  idempotencyKey?: string;
}) {
  const response = await fetch(toEventsApiUrl("/orpc/registerSubscription"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: {
        path: params.streamPath.replace(/^\/+/, ""),
        subscription: {
          type: params.subscription.type,
          URL: params.subscription.URL,
          subscriptionSlug: params.subscription.subscriptionSlug,
          ...(params.subscription.sendHistoricEventsFromOffset
            ? {
                sendHistoricEventsFromOffset: params.subscription.sendHistoricEventsFromOffset,
              }
            : {}),
        },
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

async function registerIntegrationSubscription() {
  await registerSubscription({
    streamPath: INTEGRATIONS_STREAM_PATH,
    subscription: {
      type: "webhook-with-ack",
      URL: `http://127.0.0.1:${String(env.SLACK_SERVICE_PORT)}/internal/events/integrations`,
      subscriptionSlug: integrationSubscriptionSlug,
    },
    idempotencyKey: "subscription:slack-service:integrations",
  });
}

async function ensureIntegrationSubscription() {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await registerIntegrationSubscription();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError ?? new Error("failed to register integration subscription");
}

async function ensureAgentStreamSubscription(route: SlackThreadAgentRoute): Promise<void> {
  const sinceOffset = readLatestOutboundOffset(route.agentStreamPath) ?? "0000000000000000";
  await registerSubscription({
    streamPath: route.agentStreamPath,
    subscription: {
      type: "websocket",
      URL: `ws://127.0.0.1:${String(env.SLACK_SERVICE_PORT)}/internal/ws/agent-events`,
      subscriptionSlug: route.subscriptionSlug,
      sendHistoricEventsFromOffset: sinceOffset,
    },
    idempotencyKey: `subscription:slack-ws:${route.agentStreamPath}:${route.subscriptionSlug}`,
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerOpenApiRoute(): Promise<void> {
  const servicesClient = createRegistryClient({ url: env.SERVICES_ORPC_URL });
  const routeTarget = `127.0.0.1:${String(env.SLACK_SERVICE_PORT)}`;

  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      await servicesClient.routes.upsert({
        host: serviceRegistryHost,
        target: routeTarget,
        metadata: {
          openapiPath: serviceRegistryOpenApiPath,
          title: "Slack Service",
        },
        tags: ["openapi", "slack"],
      });
      return;
    } catch {
      await delay(1_000);
    }
  }
}

async function postSlackMessage(payload: {
  channel: string;
  thread_ts: string;
  text: string;
}): Promise<void> {
  const response = await fetch(`${env.SLACK_API_BASE_URL}/api/chat.postMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN ?? "xoxb-test"}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`slack failed: ${response.status} ${await response.text()}`);
  }

  const payloadJson = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
  } | null;
  if (payloadJson?.ok === false) {
    throw new Error(`slack failed: ${payloadJson.error ?? "unknown error"}`);
  }
}

async function callAgentsGetOrCreate(agentPath: string): Promise<{
  agent: {
    agentPath: string;
    provider: "opencode";
    sessionId: string;
    streamPath: string;
  };
  wasNewlyCreated: boolean;
}> {
  const response = await fetch(`${env.AGENTS_SERVICE_BASE_URL}/api/agents/get-or-create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPath }),
  });

  if (!response.ok) {
    throw new Error(`agents get-or-create failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as {
    agent: {
      agentPath: string;
      provider: "opencode";
      sessionId: string;
      streamPath: string;
    };
    wasNewlyCreated: boolean;
  };
}

async function processIntegrationWebhookEvent(input: {
  webhook: SlackWebhookReceivedPayload;
  sourcePath: string;
  sourceOffset: string;
}): Promise<{ handled: boolean; decision: SlackWebhookDecision }> {
  const routes = listRoutesForThread({
    workspaceId: defaultWorkspaceId,
    channel: input.webhook.channel,
    threadTs: input.webhook.threadTs,
  });

  const decision = decideSlackWebhook({
    webhook: input.webhook,
    existingRoutes: routes.map(toSlackContractRoute),
  });

  if (decision.shouldCreateAgent && decision.getOrCreateInput) {
    const created = await callAgentsGetOrCreate(decision.getOrCreateInput.agentPath);
    upsertRoute({
      workspaceId: defaultWorkspaceId,
      channel: input.webhook.channel,
      threadTs: input.webhook.threadTs,
      agentPath: created.agent.agentPath,
      providerSessionId: created.agent.sessionId,
      agentStreamPath: created.agent.streamPath,
      subscriptionSlug: buildOutboundSubscriptionSlug(created.agent.streamPath),
    });
  }

  if (!decision.shouldAppendPrompt) {
    return { handled: true, decision };
  }

  const activeRoutes = listRoutesForThread({
    workspaceId: defaultWorkspaceId,
    channel: input.webhook.channel,
    threadTs: input.webhook.threadTs,
  });

  for (const route of activeRoutes) {
    await ensureAgentStreamSubscription(route);
    await appendPromptEvent({
      route,
      webhook: input.webhook,
      sourcePath: input.sourcePath,
      sourceOffset: input.sourceOffset,
    });
  }

  return { handled: true, decision };
}

async function resolveReplyTarget(params: {
  payloadReplyTarget?: { channel: string; threadTs: string };
  streamPath: string;
}): Promise<{ channel: string; threadTs: string } | null> {
  if (params.payloadReplyTarget) {
    return {
      channel: params.payloadReplyTarget.channel,
      threadTs: params.payloadReplyTarget.threadTs,
    };
  }

  const fallbackRoute = readAnyRouteByStreamPath(params.streamPath);
  if (!fallbackRoute) return null;
  return {
    channel: fallbackRoute.channel,
    threadTs: fallbackRoute.threadTs,
  };
}

async function consumeAgentStreamEvent(body: {
  type?: string;
  payload?: unknown;
  path?: string;
  offset?: string;
}): Promise<void> {
  const rawStreamPath = body.path ?? "";
  const streamPath =
    rawStreamPath.length > 0
      ? rawStreamPath.startsWith("/")
        ? rawStreamPath
        : `/${rawStreamPath}`
      : "";
  const offset = body.offset ?? "";
  if (!streamPath || !offset) return;

  if (!rememberOutboundOffset(streamPath, offset)) {
    return;
  }

  if (body.type === AGENTS_STATUS_UPDATED_TYPE) {
    const payload = AgentStatusUpdatedPayload.safeParse(body.payload);
    if (!payload.success || payload.data.phase === "idle") return;

    const replyTarget = await resolveReplyTarget({
      payloadReplyTarget: payload.data.replyTarget,
      streamPath,
    });
    if (!replyTarget) return;

    const emoji =
      payload.data.emoji ??
      (payload.data.phase === "thinking"
        ? ":thinking_face:"
        : payload.data.phase === "tool-running"
          ? ":hammer_and_wrench:"
          : payload.data.phase === "responding"
            ? ":speech_balloon:"
            : ":warning:");

    const text = payload.data.text ?? `${emoji} ${payload.data.phase}`;
    await postSlackMessage({
      channel: replyTarget.channel,
      thread_ts: replyTarget.threadTs,
      text,
    });
    return;
  }

  if (body.type === AGENTS_RESPONSE_ADDED_TYPE) {
    const payload = AgentResponseAddedPayload.safeParse(body.payload);
    if (!payload.success) return;

    const replyTarget = await resolveReplyTarget({
      payloadReplyTarget: payload.data.replyTarget,
      streamPath,
    });
    if (!replyTarget) return;

    await postSlackMessage({
      channel: replyTarget.channel,
      thread_ts: replyTarget.threadTs,
      text: payload.data.text,
    });
    return;
  }

  if (body.type === AGENTS_ERROR_TYPE) {
    const payload = AgentErrorPayload.safeParse(body.payload);
    if (!payload.success) return;

    const replyTarget = await resolveReplyTarget({
      payloadReplyTarget: payload.data.replyTarget,
      streamPath,
    });
    if (!replyTarget) return;

    await postSlackMessage({
      channel: replyTarget.channel,
      thread_ts: replyTarget.threadTs,
      text: `:warning: ${payload.data.message}`,
    });
  }
}

wsServer.on("connection", (socket) => {
  socket.on("message", (message) => {
    try {
      const text = typeof message === "string" ? message : message.toString("utf8");
      const body = JSON.parse(text) as {
        type?: string;
        payload?: unknown;
        path?: string;
        offset?: string;
      };

      void consumeAgentStreamEvent(body).catch(() => {});
    } catch {
      // ignore invalid websocket payloads from upstream
    }
  });
});

app.get("/healthz", (c) => c.text("ok"));
mountServiceSubRouterHttpRoutes({ app, manifest: slackServiceManifest });

for (const docPath of ["/api/openapi.json", "/api/docs", "/api/docs/*"]) {
  app.all(docPath, async (c) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
    });
    if (matched) return c.newResponse(response.body, response);
    return c.json({ error: "not_found" }, 404);
  });
}

app.post("/webhook", async (c) => {
  const normalized = normalizeSlackWebhookInput(await c.req.json().catch(() => ({})));
  if (!normalized.ok) {
    return c.json({ error: normalized.error, debug: normalized.debug }, 400);
  }

  await appendIntegrationEvent({
    type: INTEGRATIONS_SLACK_WEBHOOK_RECEIVED_TYPE,
    payload: normalized.event,
    idempotencyKey: `slack-webhook:${normalized.event.channel}:${normalized.event.threadTs}:${normalized.event.ts}`,
  });

  return c.json({
    ok: true as const,
    queued: true,
    streamPath: INTEGRATIONS_STREAM_PATH,
  });
});

app.post("/api/slack/debug/decide-webhook", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    webhook?: unknown;
    existingRoutes?: Array<SlackRouteRecord>;
  };

  const normalized = normalizeSlackWebhookInput(body.webhook ?? {});
  if (!normalized.ok) {
    return c.json({
      shouldCreateAgent: false,
      shouldAppendPrompt: false,
      reasonCodes: ["invalid.webhook"],
      debug: normalized.debug,
    });
  }

  const decision = decideSlackWebhook({
    webhook: normalized.event,
    existingRoutes: Array.isArray(body.existingRoutes) ? body.existingRoutes : [],
  });
  return c.json(decision);
});

app.post("/internal/events/integrations", async (c) => {
  const body = (await c.req.json()) as {
    type?: string;
    payload?: unknown;
    path?: string;
    offset?: string;
  };

  if (body.type !== INTEGRATIONS_SLACK_WEBHOOK_RECEIVED_TYPE) {
    return c.json({ ok: true as const, handled: false });
  }

  const payload = SlackWebhookReceivedPayload.safeParse(body.payload);
  if (!payload.success) {
    return c.json({ error: "invalid integrations payload" }, 400);
  }

  const sourcePath = body.path ?? "integrations/slack/webhooks";
  const sourceOffset = body.offset ?? "unknown";

  try {
    const result = await processIntegrationWebhookEvent({
      webhook: payload.data,
      sourcePath,
      sourceOffset,
    });
    return c.json({
      ok: true as const,
      handled: result.handled,
      decision: result.decision,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 502);
  }
});

app.post("/codemode", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    agentPath?: unknown;
    code?: unknown;
  } | null;

  if (!body || typeof body.agentPath !== "string" || body.agentPath.trim().length === 0) {
    return c.json({ success: false, error: "agentPath is required" }, 400);
  }

  if (typeof body.code !== "string" || body.code.trim().length === 0) {
    return c.json({ success: false, error: "code is required" }, 400);
  }

  const route = readRouteByAgentPath(body.agentPath.trim());
  if (!route) {
    return c.json({ success: false, error: "Unknown agentPath" }, 404);
  }

  const session = {
    agentPath: route.agentPath,
    workspaceId: route.workspaceId,
    channel: route.channel,
    threadTs: route.threadTs,
    streamPath: route.agentStreamPath,
  };

  const slack = {
    sendMessage: async (text: string) => {
      await postSlackMessage({
        channel: route.channel,
        thread_ts: route.threadTs,
        text,
      });
    },
    callApi: async (method: string, payload: Record<string, unknown>) => {
      const response = await fetch(`${env.SLACK_API_BASE_URL}/api/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.SLACK_BOT_TOKEN ?? "xoxb-test"}`,
        },
        body: JSON.stringify(payload),
      });
      const json = (await response.json().catch(() => null)) as unknown;
      return {
        ok: response.ok,
        status: response.status,
        data: json,
      };
    },
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  try {
    const execute = new AsyncFunction("{ slack, session, globalThis }", body.code);
    const result = await execute({
      slack,
      session,
      globalThis,
    });
    return c.json({ success: true, result });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

export const startSlackService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/internal/ws/agent-events") {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit("connection", ws, req);
      });
      return;
    }

    socket.destroy();
  });

  await new Promise<void>((resolve) => {
    server.listen(env.SLACK_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

  void registerOpenApiRoute();
  await ensureIntegrationSubscription();

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

      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });
      db.close();
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startSlackService();
}
