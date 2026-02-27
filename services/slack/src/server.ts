import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import { slackServiceManifest } from "@iterate-com/slack-contract";
import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
  AGENTS_ERROR_TYPE,
  AGENTS_RESPONSE_ADDED_TYPE,
  AGENTS_STATUS_UPDATED_TYPE,
  AgentErrorPayload,
  AgentResponseAddedPayload,
  AgentStatusUpdatedPayload,
  INTEGRATIONS_SLACK_WEBHOOK_RECEIVED_TYPE,
  SlackWebhookReceivedPayload,
} from "../../../packages/shared/src/jonasland/agents-events.ts";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";

const env = slackServiceManifest.envVars.parse(process.env);
const app = new Hono();
const INTEGRATIONS_STREAM_PATH = "/integrations/slack/webhooks";
const integrationSubscriptionSlug = "slack-service";
const serviceRegistryHost = "slack.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";
const agentUpdateDedup = new Set<string>();
const MAX_AGENT_UPDATE_DEDUP = 2_000;
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
      streamPath: "/integrations/slack/webhooks",
    })),
    integrationCallback: docsOs.slack.integrationCallback.handler(async () => ({
      ok: true,
      handled: true,
    })),
    agentUpdatesCallback: docsOs.slack.agentUpdatesCallback.handler(async () => ({
      ok: true,
      handled: true,
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

function encodeStreamPathForUrl(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toEventsApiUrl(pathname: string): string {
  return new URL(pathname, env.EVENTS_SERVICE_BASE_URL).toString();
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

async function registerIntegrationSubscription() {
  const normalizedPath = INTEGRATIONS_STREAM_PATH.replace(/^\/+/, "");
  const response = await fetch(toEventsApiUrl("/orpc/registerSubscription"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: {
        path: normalizedPath,
        subscription: {
          type: "webhook-with-ack",
          URL: `http://127.0.0.1:${String(env.SLACK_SERVICE_PORT)}/internal/events/integrations`,
          subscriptionSlug: integrationSubscriptionSlug,
        },
        idempotencyKey: "subscription:slack-service:integrations",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `events registerSubscription failed: ${response.status} ${await response.text()}`,
    );
  }
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

function rememberAgentUpdate(path: string, offset: string): boolean {
  const key = `${path}:${offset}`;
  if (agentUpdateDedup.has(key)) return false;
  agentUpdateDedup.add(key);
  if (agentUpdateDedup.size > MAX_AGENT_UPDATE_DEDUP) {
    const oldest = agentUpdateDedup.values().next().value as string | undefined;
    if (oldest) agentUpdateDedup.delete(oldest);
  }
  return true;
}

app.get("/healthz", (c) => c.text("ok"));
mountServiceSubRouterHttpRoutes({ app, manifest: slackServiceManifest });

for (const path of ["/api/openapi.json", "/api/docs", "/api/docs/*"]) {
  app.all(path, async (c) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
    });
    if (matched) return c.newResponse(response.body, response);
    return c.json({ error: "not_found" }, 404);
  });
}

app.post("/agent-change-callback", async (c) => {
  await c.req.text();
  return c.json({ ok: true });
});

app.post("/webhook", async (c) => {
  const body = (await c.req.json()) as {
    event?: {
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      type?: string;
      user?: string;
    };
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };

  const event: {
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    type?: string;
    user?: string;
  } = body.event ?? body;
  const threadTs = event.thread_ts ?? event.ts;
  const channel = event.channel;
  const text = event.text ?? "";

  if (!threadTs || !channel || text.trim().length === 0) {
    return c.json({ error: "thread_ts/ts, channel, and text are required" }, 400);
  }

  await appendIntegrationEvent({
    type: INTEGRATIONS_SLACK_WEBHOOK_RECEIVED_TYPE,
    payload: {
      source: "slack",
      channel,
      threadTs,
      ts: event.ts ?? threadTs,
      user: event.user,
      subtype: event.type,
      text,
      receivedAt: new Date().toISOString(),
    },
    idempotencyKey: `slack-webhook:${channel}:${threadTs}:${event.ts ?? threadTs}`,
  });

  return c.json({
    ok: true as const,
    queued: true,
    streamPath: INTEGRATIONS_STREAM_PATH,
  });
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

  const forward = await fetch(
    `${env.AGENTS_SERVICE_BASE_URL}/api/agents/slack/${encodeURIComponent(payload.data.threadTs)}/proxy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: payload.data.text,
        slack: {
          channel: payload.data.channel,
          threadTs: payload.data.threadTs,
          ts: payload.data.ts,
          user: payload.data.user,
          subtype: payload.data.subtype,
        },
        callbackUrl: `http://127.0.0.1:${String(env.SLACK_SERVICE_PORT)}/internal/events/agent-updates`,
        idempotencyKey: `prompt:${body.path ?? "integrations/slack/webhooks"}:${body.offset ?? "unknown"}`,
      }),
    },
  );

  if (!forward.ok) {
    return c.json({ error: `agents proxy failed: ${await forward.text()}` }, 502);
  }

  return c.json({ ok: true as const, handled: true });
});

app.post("/internal/events/agent-updates", async (c) => {
  const body = (await c.req.json()) as {
    type?: string;
    payload?: unknown;
    path?: string;
    offset?: string;
  };

  const path = body.path ?? "unknown";
  const offset = body.offset ?? "unknown";
  if (!rememberAgentUpdate(path, offset)) {
    return c.json({ ok: true as const, handled: false });
  }

  if (body.type === AGENTS_STATUS_UPDATED_TYPE) {
    const payload = AgentStatusUpdatedPayload.safeParse(body.payload);
    if (!payload.success || !payload.data.replyTarget) {
      return c.json({ ok: true as const, handled: false });
    }
    if (payload.data.phase === "idle") {
      return c.json({ ok: true as const, handled: false });
    }

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
      channel: payload.data.replyTarget.channel,
      thread_ts: payload.data.replyTarget.threadTs,
      text,
    });
    return c.json({ ok: true as const, handled: true });
  }

  if (body.type === AGENTS_RESPONSE_ADDED_TYPE) {
    const payload = AgentResponseAddedPayload.safeParse(body.payload);
    if (!payload.success || !payload.data.replyTarget) {
      return c.json({ ok: true as const, handled: false });
    }

    await postSlackMessage({
      channel: payload.data.replyTarget.channel,
      thread_ts: payload.data.replyTarget.threadTs,
      text: payload.data.text,
    });
    return c.json({ ok: true as const, handled: true });
  }

  if (body.type === AGENTS_ERROR_TYPE) {
    const payload = AgentErrorPayload.safeParse(body.payload);
    if (!payload.success || !payload.data.replyTarget) {
      return c.json({ ok: true as const, handled: false });
    }

    await postSlackMessage({
      channel: payload.data.replyTarget.channel,
      thread_ts: payload.data.replyTarget.threadTs,
      text: `:warning: ${payload.data.message}`,
    });
    return c.json({ ok: true as const, handled: true });
  }

  return c.json({ ok: true as const, handled: false });
});

export const startSlackService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
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
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startSlackService();
}
