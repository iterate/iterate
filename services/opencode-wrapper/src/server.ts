import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { createOpencodeClient, type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { opencodeWrapperServiceManifest } from "@iterate-com/opencode-wrapper-contract";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
  AGENTS_ERROR_TYPE,
  AGENTS_PROMPT_ADDED_TYPE,
  AGENTS_RESPONSE_ADDED_TYPE,
  AGENTS_STATUS_UPDATED_TYPE,
  AgentPromptAddedPayload,
  type SlackReplyTarget,
} from "../../../packages/shared/src/jonasland/agents-events.ts";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";

interface PromptExecutionState {
  keyBase: string;
  replyTarget: SlackReplyTarget;
  prompt: string;
  latestText: string;
  emittedResponse: boolean;
}

interface SessionRecord {
  id: string;
  agentPath: string;
  streamPath: string;
  createdAt: string;
  pendingPrompt?: PromptExecutionState;
}

const env = opencodeWrapperServiceManifest.envVars.parse(process.env);
const opencodeClient = createOpencodeClient({ baseUrl: env.OPENCODE_BASE_URL });
const sessionsById = new Map<string, SessionRecord>();
const sessionIdByStreamPath = new Map<string, string>();
const app = new Hono();
const serviceRegistryHost = "opencode-wrapper.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";

let stopLifecycleSubscription = false;

const docsOs = implement(opencodeWrapperServiceManifest.orpcContract);
const docsRouter = docsOs.router({
  service: {
    health: docsOs.service.health.handler(async () => ({
      ok: true,
      service: opencodeWrapperServiceManifest.name,
      version: opencodeWrapperServiceManifest.version,
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
  wrapper: {
    createSession: docsOs.wrapper.createSession.handler(async ({ input }) => ({
      route: `/sessions/${input.agentPath}`,
      sessionId: input.agentPath,
      streamPath: `/agents/opencode/${input.agentPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    })),
    forwardSessionEvents: docsOs.wrapper.forwardSessionEvents.handler(async () => ({
      ok: true,
    })),
    providerCallback: docsOs.wrapper.providerCallback.handler(async () => ({
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
          title: "jonasland opencode-wrapper-service API",
          version: opencodeWrapperServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

function nowIso(): string {
  return new Date().toISOString();
}

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

function normalizeStreamPath(path: string): string {
  const normalized = `/${path.replace(/^\/+/, "")}`;
  if (normalized === "/") {
    throw new Error("missing stream path");
  }
  return normalized;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toModelRef(): string {
  return `${env.OPENCODE_PROVIDER_ID}/${env.OPENCODE_MODEL_ID}`;
}

function extractSessionId(event: OpencodeEvent): string | null {
  switch (event.type) {
    case "session.status":
    case "session.idle":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID ?? null;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    default:
      return null;
  }
}

function toolStatusText(
  event: Extract<OpencodeEvent, { type: "message.part.updated" }>,
): string | null {
  const part = event.properties.part;
  if (part.type !== "tool") return null;

  const state = part.state;
  if (state.status !== "running" && state.status !== "completed") {
    return null;
  }

  const title = "title" in state && typeof state.title === "string" ? state.title.trim() : "";
  const description =
    state.input && typeof state.input.description === "string"
      ? state.input.description.trim()
      : "";
  const fallback = part.tool?.trim() || "Working";
  const text = title || description || fallback;
  return text.length > 0 ? text : null;
}

function sessionErrorMessage(event: Extract<OpencodeEvent, { type: "session.error" }>): string {
  const maybeMessage =
    "error" in event.properties && typeof event.properties.error === "string"
      ? event.properties.error
      : "message" in event.properties && typeof event.properties.message === "string"
        ? event.properties.message
        : "OpenCode session failed";
  const trimmed = maybeMessage.trim();
  return trimmed.length > 0 ? trimmed : "OpenCode session failed";
}

async function appendEventToStream(params: {
  streamPath: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
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
          idempotencyKey: params.idempotencyKey,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`events append failed: ${response.status} ${await response.text()}`);
  }
}

async function emitPromptError(session: SessionRecord, message: string): Promise<void> {
  const pending = session.pendingPrompt;
  if (!pending) return;

  await appendEventToStream({
    streamPath: session.streamPath,
    type: AGENTS_ERROR_TYPE,
    payload: {
      message,
      retryable: false,
      replyTarget: pending.replyTarget,
    },
    idempotencyKey: `${pending.keyBase}:error`,
  }).catch(() => {});

  session.pendingPrompt = undefined;
}

async function flushPromptResponseIfNeeded(session: SessionRecord): Promise<void> {
  const pending = session.pendingPrompt;
  if (!pending || pending.emittedResponse) return;

  const text = pending.latestText.trim();
  if (!text) return;

  await appendEventToStream({
    streamPath: session.streamPath,
    type: AGENTS_RESPONSE_ADDED_TYPE,
    payload: {
      text,
      replyTarget: pending.replyTarget,
      model: toModelRef(),
    },
    idempotencyKey: `${pending.keyBase}:response`,
  });
  pending.emittedResponse = true;
}

async function handleSessionIdle(session: SessionRecord): Promise<void> {
  const pending = session.pendingPrompt;
  if (!pending) return;

  await flushPromptResponseIfNeeded(session);

  await appendEventToStream({
    streamPath: session.streamPath,
    type: AGENTS_STATUS_UPDATED_TYPE,
    payload: {
      phase: "idle",
      text: "",
      replyTarget: pending.replyTarget,
    },
    idempotencyKey: `${pending.keyBase}:status:idle`,
  });

  session.pendingPrompt = undefined;
}

async function handleOpencodeEvent(event: OpencodeEvent): Promise<void> {
  const sessionId = extractSessionId(event);
  if (!sessionId) return;

  const session = sessionsById.get(sessionId);
  if (!session) return;

  const pending = session.pendingPrompt;
  if (!pending) return;

  if (event.type === "session.status") {
    if (event.properties.status.type === "busy") {
      await appendEventToStream({
        streamPath: session.streamPath,
        type: AGENTS_STATUS_UPDATED_TYPE,
        payload: {
          phase: "thinking",
          text: ":thinking_face: Thinking...",
          emoji: ":thinking_face:",
          replyTarget: pending.replyTarget,
        },
        idempotencyKey: `${pending.keyBase}:status:thinking`,
      });
      return;
    }

    if (event.properties.status.type === "idle") {
      await handleSessionIdle(session);
      return;
    }
  }

  if (event.type === "message.part.updated") {
    const toolText = toolStatusText(event);
    if (toolText) {
      const toolPart = event.properties.part;
      const toolState = toolPart.type === "tool" ? toolPart.state : undefined;
      const toolStatus =
        toolState && (toolState.status === "running" || toolState.status === "completed")
          ? toolState.status
          : "unknown";

      await appendEventToStream({
        streamPath: session.streamPath,
        type: AGENTS_STATUS_UPDATED_TYPE,
        payload: {
          phase: "tool-running",
          text: `:hammer_and_wrench: ${toolText}`,
          emoji: ":hammer_and_wrench:",
          replyTarget: pending.replyTarget,
        },
        idempotencyKey: `${pending.keyBase}:tool:${toolPart.id}:${toolStatus}`,
      });
      return;
    }

    const part = event.properties.part;
    if (part.type === "text") {
      const text = normalizeText(part.text);
      if (text) {
        pending.latestText = text;
      }

      await appendEventToStream({
        streamPath: session.streamPath,
        type: AGENTS_STATUS_UPDATED_TYPE,
        payload: {
          phase: "responding",
          text: ":speech_balloon: Responding...",
          emoji: ":speech_balloon:",
          replyTarget: pending.replyTarget,
        },
        idempotencyKey: `${pending.keyBase}:status:responding`,
      });
      return;
    }
  }

  if (event.type === "session.idle") {
    await handleSessionIdle(session);
    return;
  }

  if (event.type === "session.error") {
    await emitPromptError(session, sessionErrorMessage(event));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLifecycleSubscriptionLoop(): Promise<void> {
  while (!stopLifecycleSubscription) {
    try {
      const result = await opencodeClient.global.event();
      for await (const globalEvent of result.stream) {
        if (stopLifecycleSubscription) {
          return;
        }

        await handleOpencodeEvent(globalEvent.payload).catch(() => {});
      }
    } catch {
      // Keep retrying while service is alive.
    }

    if (!stopLifecycleSubscription) {
      await sleep(1_000);
    }
  }
}

async function registerOpenApiRoute(): Promise<void> {
  const servicesClient = createRegistryClient({ url: env.SERVICES_ORPC_URL });
  const routeTarget = `127.0.0.1:${String(env.OPENCODE_WRAPPER_SERVICE_PORT)}`;

  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      await servicesClient.routes.upsert({
        host: serviceRegistryHost,
        target: routeTarget,
        metadata: {
          openapiPath: serviceRegistryOpenApiPath,
          title: "OpenCode Wrapper Service",
        },
        tags: ["openapi", "opencode-wrapper"],
      });
      return;
    } catch {
      await sleep(1_000);
    }
  }
}

app.get("/healthz", (c) => c.text("ok"));
mountServiceSubRouterHttpRoutes({ app, manifest: opencodeWrapperServiceManifest });

for (const path of ["/api/openapi.json", "/api/docs", "/api/docs/*"]) {
  app.all(path, async (c) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
    });
    if (matched) return c.newResponse(response.body, response);
    return c.json({ error: "not_found" }, 404);
  });
}

app.post("/new", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string };
  const agentPath = normalizeText(body.agentPath);
  if (!agentPath) return c.json({ error: "agentPath is required" }, 400);

  const health = await opencodeClient.global.health().catch(() => null);
  if (!health?.data?.healthy) {
    return c.json({ error: "opencode is not healthy" }, 503);
  }

  const created = await opencodeClient.session.create({
    title: `Agent: ${agentPath}`,
  });

  const sessionId = normalizeText(created.data?.id);
  if (!sessionId) {
    return c.json({ error: "failed to create opencode session" }, 502);
  }

  const streamPath = `/agents/opencode/${sessionId}`;
  const record: SessionRecord = {
    id: sessionId,
    agentPath,
    streamPath,
    createdAt: nowIso(),
  };

  sessionsById.set(sessionId, record);
  sessionIdByStreamPath.set(streamPath, sessionId);

  return c.json({
    route: `/sessions/${sessionId}`,
    sessionId,
    streamPath,
  });
});

app.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessionsById.get(sessionId);
  if (!session) return c.json({ error: "session not found" }, 404);

  await c.req.json().catch(() => null);

  return c.json({ ok: true as const, sessionId: session.id });
});

app.post("/internal/events/provider", async (c) => {
  const body = (await c.req.json()) as {
    type?: string;
    payload?: unknown;
    path?: string;
    offset?: string;
  };

  if (body.type !== AGENTS_PROMPT_ADDED_TYPE) {
    return c.json({ ok: true as const, handled: false });
  }

  const payload = AgentPromptAddedPayload.safeParse(body.payload);
  if (!payload.success) {
    return c.json({ error: "invalid provider payload" }, 400);
  }

  let streamPath: string;
  try {
    streamPath = normalizeStreamPath(body.path ?? "");
  } catch {
    return c.json({ error: "missing stream path" }, 400);
  }

  const sessionId = sessionIdByStreamPath.get(streamPath);
  if (!sessionId) {
    return c.json({ error: "unknown stream path" }, 404);
  }

  const session = sessionsById.get(sessionId);
  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  const keyBase = `${streamPath}:${body.offset ?? "unknown"}`;
  session.pendingPrompt = {
    keyBase,
    prompt: payload.data.prompt,
    replyTarget: payload.data.replyTarget,
    latestText: "",
    emittedResponse: false,
  };

  try {
    await opencodeClient.session.promptAsync({
      sessionID: session.id,
      parts: [{ type: "text", text: payload.data.prompt }],
      model: {
        providerID: env.OPENCODE_PROVIDER_ID,
        modelID: env.OPENCODE_MODEL_ID,
      },
    });
  } catch (error) {
    await emitPromptError(
      session,
      error instanceof Error ? error.message : "failed to start opencode prompt",
    );
  }

  return c.json({ ok: true as const, handled: true });
});

export const startOpencodeWrapperService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(env.OPENCODE_WRAPPER_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

  void registerOpenApiRoute();
  void runLifecycleSubscriptionLoop();

  return {
    close: async () => {
      stopLifecycleSubscription = true;

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
  void startOpencodeWrapperService();
}
