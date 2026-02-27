import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
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
} from "../../../packages/shared/src/jonasland/agents-events.ts";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";

interface SessionRecord {
  id: string;
  agentPath: string;
  streamPath: string;
  createdAt: string;
}

const env = opencodeWrapperServiceManifest.envVars.parse(process.env);
const sessions = new Map<string, SessionRecord>();
const app = new Hono();
const serviceRegistryHost = "opencode-wrapper.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";
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
      route: `/sessions/stub-${input.agentPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      sessionId: `stub-${input.agentPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      streamPath: `/agents/opencode/stub-${input.agentPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
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

async function callModel(prompt: string): Promise<string> {
  const response = await fetch(`${env.OPENAI_BASE_URL}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "test-key"}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      input: prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`openai failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  const textFromOutput = payload.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .find((value): value is string => typeof value === "string" && value.length > 0);

  return textFromOutput ?? "No response text returned.";
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
      await delay(1_000);
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
  const agentPath = body.agentPath?.trim();
  if (!agentPath) return c.json({ error: "agentPath is required" }, 400);

  await fetch(`${env.OPENCODE_BASE_URL}/healthz`).catch(() => {
    // opencode process is best-effort in this minimal wrapper
  });

  const sessionId = randomUUID();
  const streamPath = `/agents/opencode/${sessionId}`;
  sessions.set(sessionId, {
    id: sessionId,
    agentPath,
    streamPath,
    createdAt: new Date().toISOString(),
  });

  return c.json({
    route: `/sessions/${sessionId}`,
    sessionId,
    streamPath,
  });
});

app.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "session not found" }, 404);

  await c.req.json().catch(() => null);

  return c.json({ ok: true as const });
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

  const streamPath = `/${(body.path ?? "").replace(/^\/+/, "")}`;
  if (streamPath === "/") {
    return c.json({ error: "missing stream path" }, 400);
  }

  const keyBase = `${streamPath}:${body.offset ?? "unknown"}`;

  try {
    await appendEventToStream({
      streamPath,
      type: AGENTS_STATUS_UPDATED_TYPE,
      payload: {
        phase: "thinking",
        text: ":thinking_face: Thinking...",
        emoji: ":thinking_face:",
        replyTarget: payload.data.replyTarget,
      },
      idempotencyKey: `${keyBase}:status:thinking`,
    });

    const modelResponse = await callModel(payload.data.prompt);

    await appendEventToStream({
      streamPath,
      type: AGENTS_RESPONSE_ADDED_TYPE,
      payload: {
        text: modelResponse,
        replyTarget: payload.data.replyTarget,
        model: env.OPENAI_MODEL,
      },
      idempotencyKey: `${keyBase}:response`,
    });

    await appendEventToStream({
      streamPath,
      type: AGENTS_STATUS_UPDATED_TYPE,
      payload: {
        phase: "idle",
        text: "",
        replyTarget: payload.data.replyTarget,
      },
      idempotencyKey: `${keyBase}:status:idle`,
    });
  } catch (error) {
    await appendEventToStream({
      streamPath,
      type: AGENTS_ERROR_TYPE,
      payload: {
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        replyTarget: payload.data.replyTarget,
      },
      idempotencyKey: `${keyBase}:error`,
    }).catch(() => {});
  }

  return c.json({ ok: true as const, handled: true });
});

export const startOpencodeWrapperService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(env.OPENCODE_WRAPPER_SERVICE_PORT, "0.0.0.0", () => resolve());
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
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startOpencodeWrapperService();
}
