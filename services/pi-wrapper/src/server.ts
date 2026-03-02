import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import {
  AuthStorage,
  createCodingTools,
  createAgentSession,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { getApiProvider, registerApiProvider } from "@mariozechner/pi-ai";
import { piWrapperServiceManifest } from "@iterate-com/pi-wrapper-contract";
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
  emittedRespondingStatus: boolean;
}

interface SessionRecord {
  id: string;
  agentPath: string;
  streamPath: string;
  createdAt: string;
  session: AgentSession;
  unsubscribe: () => void;
  queuedPrompts: PromptExecutionState[];
  activePrompt?: PromptExecutionState;
  eventSerial: Promise<void>;
}

const env = piWrapperServiceManifest.envVars.parse(process.env);
const authStorage = AuthStorage.create(path.join(env.PI_AGENT_DIR, "auth.json"));
const modelRegistry = new ModelRegistry(authStorage, path.join(env.PI_AGENT_DIR, "models.json"));
const sessionsById = new Map<string, SessionRecord>();
const sessionIdByStreamPath = new Map<string, string>();
const app = new Hono();
const serviceRegistryHost = "pi-wrapper.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";

function patchCodexStreamSimpleTransport(): void {
  const api = "openai-codex-responses" as const;
  const provider = getApiProvider(api);
  if (!provider) return;

  registerApiProvider(
    {
      api,
      stream: provider.stream,
      // pi-ai@0.55.3 drops `transport` in streamSimple for codex; preserve it here.
      streamSimple: (model, context, options) => {
        const streamOptions = {
          apiKey: options?.apiKey,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
          signal: options?.signal,
          cacheRetention: options?.cacheRetention,
          sessionId: options?.sessionId,
          headers: options?.headers,
          onPayload: options?.onPayload,
          maxRetryDelayMs: options?.maxRetryDelayMs,
          metadata: options?.metadata,
          transport: options?.transport,
          ...(options?.reasoning ? { reasoningEffort: options.reasoning } : {}),
        } as unknown as Parameters<typeof provider.stream>[2];

        return provider.stream(model, context, streamOptions);
      },
    },
    "pi-wrapper-codex-transport-patch",
  );
}

patchCodexStreamSimpleTransport();

const docsOs = implement(piWrapperServiceManifest.orpcContract);
const docsRouter = docsOs.router({
  service: {
    health: docsOs.service.health.handler(async () => ({
      ok: true,
      service: piWrapperServiceManifest.name,
      version: piWrapperServiceManifest.version,
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
      streamPath: `/agents/pi/${input.agentPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
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
          title: "jonasland pi-wrapper-service API",
          version: piWrapperServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

function nowIso(): string {
  return new Date().toISOString();
}

function encodeStreamPathForUrl(streamPath: string): string {
  return streamPath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toEventsApiUrl(pathname: string): string {
  return new URL(pathname, env.EVENTS_SERVICE_BASE_URL).toString();
}

function normalizeStreamPath(streamPath: string): string {
  const normalized = `/${streamPath.replace(/^\/+/, "")}`;
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
  return `${env.PI_MODEL_PROVIDER}/${env.PI_MODEL_ID}`;
}

function providerSubscriptionSlug(sessionId: string): string {
  return `provider-pi-${sessionId}`;
}

function providerCallbackUrl(): string {
  return `http://127.0.0.1:${String(env.PI_WRAPPER_SERVICE_PORT)}/internal/events/provider`;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const messageRecord = message as {
    role?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (messageRecord.role !== "assistant" || !Array.isArray(messageRecord.content)) {
    return "";
  }

  return messageRecord.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function latestAssistantText(session: AgentSession): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    const text = extractAssistantText(message);
    if (text.length > 0) {
      return text;
    }
  }
  return "";
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

async function registerProviderSubscription(params: { streamPath: string; sessionId: string }) {
  const response = await fetch(toEventsApiUrl("/orpc/registerSubscription"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: {
        path: params.streamPath.replace(/^\/+/, ""),
        subscription: {
          type: "webhook",
          URL: providerCallbackUrl(),
          subscriptionSlug: providerSubscriptionSlug(params.sessionId),
        },
        idempotencyKey: `subscription:provider:pi:${params.streamPath}`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `events registerSubscription failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function emitPromptError(params: {
  session: SessionRecord;
  prompt: PromptExecutionState;
  message: string;
}): Promise<void> {
  await appendEventToStream({
    streamPath: params.session.streamPath,
    type: AGENTS_ERROR_TYPE,
    payload: {
      message: params.message,
      retryable: false,
      replyTarget: params.prompt.replyTarget,
    },
    idempotencyKey: `${params.prompt.keyBase}:error`,
  }).catch(() => {});
}

async function flushPromptResponseIfNeeded(params: {
  session: SessionRecord;
  prompt: PromptExecutionState;
}): Promise<void> {
  if (params.prompt.emittedResponse) return;

  const candidate = params.prompt.latestText.trim();
  const text = candidate.length > 0 ? candidate : latestAssistantText(params.session.session);
  if (!text) return;

  await appendEventToStream({
    streamPath: params.session.streamPath,
    type: AGENTS_RESPONSE_ADDED_TYPE,
    payload: {
      text,
      replyTarget: params.prompt.replyTarget,
      model: toModelRef(),
    },
    idempotencyKey: `${params.prompt.keyBase}:response`,
  });

  params.prompt.emittedResponse = true;
}

async function handlePiSessionEvent(
  session: SessionRecord,
  event: AgentSessionEvent,
): Promise<void> {
  const activePrompt = session.activePrompt;
  if (!activePrompt) return;

  if (event.type === "tool_execution_start") {
    await appendEventToStream({
      streamPath: session.streamPath,
      type: AGENTS_STATUS_UPDATED_TYPE,
      payload: {
        phase: "tool-running",
        text: `:hammer_and_wrench: ${event.toolName}`,
        emoji: ":hammer_and_wrench:",
        replyTarget: activePrompt.replyTarget,
      },
      idempotencyKey: `${activePrompt.keyBase}:tool:start:${event.toolCallId}`,
    });
    return;
  }

  if (event.type === "tool_execution_update") {
    await appendEventToStream({
      streamPath: session.streamPath,
      type: AGENTS_STATUS_UPDATED_TYPE,
      payload: {
        phase: "tool-running",
        text: `:hammer_and_wrench: ${event.toolName}`,
        emoji: ":hammer_and_wrench:",
        replyTarget: activePrompt.replyTarget,
      },
      idempotencyKey: `${activePrompt.keyBase}:tool:update:${event.toolCallId}`,
    });
    return;
  }

  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === "text_delta") {
      activePrompt.latestText += assistantEvent.delta;
    } else if (assistantEvent.type === "text_end") {
      const ended = normalizeText(assistantEvent.content);
      if (ended) {
        activePrompt.latestText = ended;
      }
    } else {
      return;
    }

    if (!activePrompt.emittedRespondingStatus) {
      await appendEventToStream({
        streamPath: session.streamPath,
        type: AGENTS_STATUS_UPDATED_TYPE,
        payload: {
          phase: "responding",
          text: ":speech_balloon: Responding...",
          emoji: ":speech_balloon:",
          replyTarget: activePrompt.replyTarget,
        },
        idempotencyKey: `${activePrompt.keyBase}:status:responding`,
      });
      activePrompt.emittedRespondingStatus = true;
    }
  }
}

async function runNextPrompt(session: SessionRecord): Promise<void> {
  if (session.activePrompt) return;

  const nextPrompt = session.queuedPrompts.shift();
  if (!nextPrompt) return;

  session.activePrompt = nextPrompt;

  try {
    await appendEventToStream({
      streamPath: session.streamPath,
      type: AGENTS_STATUS_UPDATED_TYPE,
      payload: {
        phase: "thinking",
        text: ":thinking_face: Thinking...",
        emoji: ":thinking_face:",
        replyTarget: nextPrompt.replyTarget,
      },
      idempotencyKey: `${nextPrompt.keyBase}:status:thinking`,
    });

    await session.session.prompt(nextPrompt.prompt);
    await flushPromptResponseIfNeeded({ session, prompt: nextPrompt });

    await appendEventToStream({
      streamPath: session.streamPath,
      type: AGENTS_STATUS_UPDATED_TYPE,
      payload: {
        phase: "idle",
        text: "",
        replyTarget: nextPrompt.replyTarget,
      },
      idempotencyKey: `${nextPrompt.keyBase}:status:idle`,
    });
  } catch (error) {
    await emitPromptError({
      session,
      prompt: nextPrompt,
      message: error instanceof Error ? error.message : "failed to execute pi prompt",
    });
  } finally {
    if (session.activePrompt === nextPrompt) {
      session.activePrompt = undefined;
    }
    void runNextPrompt(session);
  }
}

function enqueuePrompt(session: SessionRecord, prompt: PromptExecutionState): void {
  session.queuedPrompts.push(prompt);
  if (!session.activePrompt) {
    void runNextPrompt(session);
  }
}

async function createPiSessionRecord(agentPath: string): Promise<SessionRecord> {
  const model = modelRegistry.find(env.PI_MODEL_PROVIDER, env.PI_MODEL_ID);
  if (!model) {
    throw new Error(`pi model not found: ${toModelRef()}`);
  }

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    cwd: env.PI_WORKING_DIRECTORY,
    agentDir: env.PI_AGENT_DIR,
    sessionManager: SessionManager.inMemory(),
    tools: createCodingTools(env.PI_WORKING_DIRECTORY),
    settingsManager: SettingsManager.inMemory({
      transport: env.PI_MODEL_TRANSPORT,
    }),
  });

  const sessionId = normalizeText(session.sessionId);
  if (!sessionId) {
    throw new Error("failed to create pi session");
  }

  const streamPath = `/agents/pi/${sessionId}`;

  const record: SessionRecord = {
    id: sessionId,
    agentPath,
    streamPath,
    createdAt: nowIso(),
    session,
    unsubscribe: () => {},
    queuedPrompts: [],
    eventSerial: Promise.resolve(),
  };

  const unsubscribe = session.subscribe((event) => {
    record.eventSerial = record.eventSerial
      .then(async () => {
        await handlePiSessionEvent(record, event);
      })
      .catch(() => {});
  });

  record.unsubscribe = unsubscribe;
  return record;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerOpenApiRoute(): Promise<void> {
  const servicesClient = createRegistryClient({ url: env.SERVICES_ORPC_URL });
  const routeTarget = `127.0.0.1:${String(env.PI_WRAPPER_SERVICE_PORT)}`;

  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      await servicesClient.routes.upsert({
        host: serviceRegistryHost,
        target: routeTarget,
        metadata: {
          openapiPath: serviceRegistryOpenApiPath,
          title: "Pi Wrapper Service",
        },
        tags: ["openapi", "pi-wrapper"],
      });
      return;
    } catch {
      await sleep(1_000);
    }
  }
}

app.get("/healthz", (c) => c.text("ok"));
mountServiceSubRouterHttpRoutes({ app, manifest: piWrapperServiceManifest });

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

  try {
    const record = await createPiSessionRecord(agentPath);
    sessionsById.set(record.id, record);
    sessionIdByStreamPath.set(record.streamPath, record.id);
    try {
      await registerProviderSubscription({ streamPath: record.streamPath, sessionId: record.id });
    } catch (error) {
      record.unsubscribe();
      record.session.dispose();
      sessionsById.delete(record.id);
      sessionIdByStreamPath.delete(record.streamPath);
      throw error;
    }

    return c.json({
      route: `/sessions/${record.id}`,
      sessionId: record.id,
      streamPath: record.streamPath,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "failed to create pi session",
      },
      502,
    );
  }
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

  const sessionIdFromPath = normalizeText(streamPath.split("/").at(-1));
  const sessionId = sessionIdByStreamPath.get(streamPath) ?? sessionIdFromPath ?? undefined;
  const session =
    (sessionId ? sessionsById.get(sessionId) : undefined) ??
    (sessionsById.size === 1 ? Array.from(sessionsById.values())[0] : undefined);
  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  const prompt: PromptExecutionState = {
    keyBase: `${streamPath}:${body.offset ?? "unknown"}`,
    prompt: payload.data.prompt,
    replyTarget: payload.data.replyTarget,
    latestText: "",
    emittedResponse: false,
    emittedRespondingStatus: false,
  };

  enqueuePrompt(session, prompt);
  return c.json({ ok: true as const, handled: true });
});

export const startPiWrapperService = async () => {
  mkdirSync(path.resolve(env.PI_AGENT_DIR), { recursive: true });

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(env.PI_WRAPPER_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

  void registerOpenApiRoute();

  return {
    close: async () => {
      for (const session of sessionsById.values()) {
        session.unsubscribe();
        session.session.dispose();
      }
      sessionsById.clear();
      sessionIdByStreamPath.clear();

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
  void startPiWrapperService();
}
