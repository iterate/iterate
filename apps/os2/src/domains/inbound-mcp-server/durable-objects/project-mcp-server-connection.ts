import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Connection } from "agents";
import { z } from "zod";
import { StreamPath, type Event, type EventInput } from "@iterate-com/shared/streams/types";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { upsertD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import packageJson from "../../../../package.json" with { type: "json" };
import { createExampleCapabilityProviders } from "~/domains/codemode/example-provider-registrations.ts";
import { createGmailProviderRegistration } from "~/domains/google/gmail-provider-registration.ts";
import {
  type CodemodeSessionNamespace,
  startCodemodeScriptOnSession,
} from "~/domains/codemode/codemode-session-rpc.ts";
import {
  getStreamsCapability,
  type StreamsCapabilityProps,
} from "~/domains/streams/entrypoints/streams-capability.ts";
import { createDefaultOutboundMcpProviderRegistrations } from "~/domains/codemode/default-provider-registrations.ts";
import { readEventPayload, stringifyPayloadError } from "~/lib/codemode-event-payload.ts";
import { createOpenApiProviderRegistration } from "~/rpc-targets/openapi-provider-registration.ts";
import { createOutboundMcpFromOurClientToolProviderRegistration } from "~/domains/outbound-mcp-client/utils/outbound-mcp-provider-registration.ts";

export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";

/**
 * Project-scoped MCP server connection for os2.
 *
 * Runs as a Durable Object in a separate Worker (`project-mcp-server-connection-do`).
 * `entry.workerd.ts` verifies Clerk OAuth, resolves the request hostname to a
 * project, and passes that identity into this Durable Object through McpAgent
 * props. That mirrors Cloudflare's documented OAuth integration point while
 * letting Clerk remain the authorization server:
 * https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/
 *
 * Code execution is delegated to the project/stream-scoped CodemodeSession DO.
 *
 * Tools:
 * - exec_js: Execute JavaScript in an isolated dynamic worker sandbox
 */

interface McpServerEnv {
  CODEMODE_SESSION: CodemodeSessionNamespace;
  DO_CATALOG: D1Database;
  MOCK_PROVIDER_BASE_URL?: string;
  PROJECT_MCP_SERVER_CONNECTION: DurableObjectNamespace;
}

export interface ProjectMcpServerConnectionProps extends Record<string, unknown> {
  projectId: string | null;
  projectSlug: string | null;
  userId: string;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[];
  scopes: string[];
  clientId: string | null;
  clerkTokenType?: "admin_api_secret" | "oauth_token" | "session_token";
}

export type ProjectMcpServerConnectionStructuredName = {
  projectId: string;
  projectSlug: string | null;
  orgId: string;
  orgSlug: string | null;
  userId: string;
  clientId: string | null;
  clientName: string | null;
  streamPath: StreamPath;
};

const ProjectMcpServerConnectionStructuredName = z.object({
  projectId: z.string(),
  projectSlug: z.string().nullable(),
  orgId: z.string(),
  orgSlug: z.string().nullable(),
  userId: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  streamPath: StreamPath,
});

const sessionSlugStorageKey = "mcpServerSessionSlug";
const eventTypePrefix = "events.iterate.com/mcp-server";
const requiredToolScope = "profile";

export class ProjectMcpServerConnection extends McpAgent<
  McpServerEnv,
  unknown,
  ProjectMcpServerConnectionProps
> {
  server = new McpServer(
    {
      name: "os2",
      version: packageJson.version,
    },
    {
      instructions: [
        "This is an Iterate OS2 project MCP server. You have one tool: exec_js.",
        "",
        "exec_js runs JavaScript in an isolated sandbox. The code MUST be a single async arrow function: `async (ctx) => { ... }`.",
        "",
        "The `ctx` object provides registered tool providers. Call them as `ctx.<path>.<method>(args)`. Available providers are listed in the exec_js tool description.",
        "",
        "Use `Promise.all([...])` for concurrent operations. Use `fetch` for HTTP requests. The return value is sent back as the result. Do NOT write bare statements — always wrap in `async (ctx) => { ... }`.",
      ].join("\n"),
    },
  );

  async setInitializeRequest(initializeRequest: Parameters<McpAgent["setInitializeRequest"]>[0]) {
    await super.setInitializeRequest(initializeRequest);
    await this.initializeCatalogRecord();
    await this.emitLifecycleEvent("session-started", {
      transportType: this.getTransportType(),
      mcpSessionId: this.getSessionId(),
      clientInfo: await this.getClientInfo(),
    });
  }

  async onConnect(
    connection: Connection,
    context: Parameters<McpAgent<McpServerEnv>["onConnect"]>[1],
  ) {
    await this.emitLifecycleEvent("connection-opened", {
      connectionId: connection.id,
      transportType: this.getTransportType(),
      request: summarizeRequest(context.request),
    });

    await super.onConnect(connection, context);
  }

  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean) {
    await this.emitLifecycleEvent("connection-closed", {
      code,
      connectionId: connection.id,
      reason,
      wasClean,
    });

    await super.onClose(connection, code, reason, wasClean);
  }

  async onError(connectionOrError: Connection | unknown, maybeError?: unknown) {
    const hasConnection = maybeError !== undefined;
    await this.emitLifecycleEvent("error-occurred", {
      connectionId: hasConnection ? (connectionOrError as Connection).id : null,
      error: serializeError(hasConnection ? maybeError : connectionOrError),
    });

    if (hasConnection) {
      return super.onError(connectionOrError as Connection, maybeError);
    }

    return super.onError(connectionOrError);
  }

  async init() {
    const providers = this.createStaticCodemodeToolProviders(this.requireProjectAuthProps());
    const providerDocs = [...createDefaultOutboundMcpProviderRegistrations(), ...providers]
      .map((p) => `- ctx.${p.path.join(".")}: ${p.instructions}`)
      .join("\n");

    this.server.registerTool(
      "exec_js",
      {
        title: "Run code",
        description: [
          "Execute JavaScript in an isolated sandbox. The code MUST be a single async arrow function: `async (ctx) => { ... }`.",
          "",
          "The function receives a `ctx` object with registered tool providers. Use `Promise.all([...])` for concurrent operations. Use `fetch` for HTTP. The return value (or thrown error) is sent back as the tool result.",
          "If you're not sure about the shape of the result of a function call, just return it from a codemode block and you'll be shown it on your next turn.",
          "",
          "Available tool providers on ctx:",
          providerDocs,
          "",
          'Example: async (ctx) => { const msgs = await ctx.gmail.request({ path: "/gmail/v1/users/me/messages", query: { maxResults: 5 } }); return msgs.data; }',
        ].join("\n"),
        inputSchema: z.object({
          code: z
            .string()
            .describe(
              "JavaScript async arrow function to execute, e.g. `async (ctx) => { return await ctx.os.listProcedures(); }`",
            ),
        }),
      },
      async ({ code }) => {
        const auth = this.requireProjectAuthProps();
        this.requireScope(auth, requiredToolScope);
        const staticProviders = providers.slice(0, readDebugProviderLimit(code));

        const invocationId = `mcp_tool_${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const streamPath = await this.getSessionStreamPath();
        debugCodemodeDepth("mcp.exec_js.start", {
          invocationId,
          providerCount: staticProviders.length,
          sessionId: this.getSessionId(),
          streamPath,
        });

        await this.emitLifecycleEvent("tool-invocation-started", {
          auth: summarizeAuthProps(auth),
          input: { code, providerCount: staticProviders.length },
          invocationId,
          projectId: auth.projectId,
          projectSlug: auth.projectSlug,
          streamPath,
          toolName: "exec_js",
        });
        debugCodemodeDepth("mcp.exec_js.afterStartedLifecycle", {
          invocationId,
          elapsedMs: Date.now() - startedAt,
        });

        try {
          debugCodemodeDepth("mcp.exec_js.beforeStartSession", {
            invocationId,
            elapsedMs: Date.now() - startedAt,
          });
          const started = await startCodemodeScriptOnSession({
            code,
            events: [],
            namespace: this.env.CODEMODE_SESSION,
            projectId: auth.projectId,
            providers: staticProviders,
            streamPath,
          });
          debugCodemodeDepth("mcp.exec_js.afterStartSession", {
            invocationId,
            elapsedMs: Date.now() - startedAt,
            offset: started.event.offset,
          });
          const output = await waitForScriptExecutionFinished({
            afterOffset: started.event.offset,
            exports: this.workerExports(),
            projectId: auth.projectId,
            scriptExecutionId: String(
              (started.event.payload as { scriptExecutionId?: unknown }).scriptExecutionId,
            ),
            streamPath,
          });

          const parts: string[] = [];
          if (output.logs.length > 0) parts.push(`Console:\n${output.logs.join("\n")}`);
          if (output.error) {
            parts.push(`Error: ${output.error}`);
          } else {
            parts.push(`Result: ${JSON.stringify(output.result, null, 2)}`);
          }

          const response = {
            content: [{ type: "text" as const, text: parts.join("\n\n") }],
            isError: !!output.error,
          };

          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            durationMs: Date.now() - startedAt,
            input: {
              code,
              providerCount: staticProviders.length,
            },
            invocationId,
            output: response,
            projectId: auth.projectId,
            projectSlug: auth.projectSlug,
            result: output,
            scriptExecutionId: (started.event.payload as { scriptExecutionId?: unknown })
              .scriptExecutionId,
            streamPath,
            toolName: "exec_js",
          });

          return response;
        } catch (error) {
          debugCodemodeDepth("mcp.exec_js.error", {
            invocationId,
            elapsedMs: Date.now() - startedAt,
            error: serializeError(error),
          });
          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            durationMs: Date.now() - startedAt,
            error: serializeError(error),
            input: {
              code,
              providerCount: staticProviders.length,
            },
            invocationId,
            isError: true,
            projectId: auth.projectId,
            projectSlug: auth.projectSlug,
            streamPath,
            toolName: "exec_js",
          });

          throw error;
        }
      },
    );
  }

  private createStaticCodemodeToolProviders(
    auth: ProjectMcpServerConnectionProps & { orgId: string; projectId: string },
  ): ToolProviderRegistration[] {
    const providers = createExampleCapabilityProviders({
      activeOrganization: {
        orgId: auth.orgId,
        orgPermissions: auth.orgPermissions,
        orgRole: auth.orgRole,
        orgSlug: auth.orgSlug ?? auth.orgId,
        sessionId: this.getSessionId(),
        userId: auth.userId,
      },
      projectId: auth.projectId,
    });

    providers.push(createGmailProviderRegistration({ projectId: auth.projectId }));

    const providerMatrixBaseUrl = this.env.MOCK_PROVIDER_BASE_URL?.replace(/\/+$/, "");
    providers.push(
      createOpenApiProviderRegistration({
        baseUrl: providerMatrixBaseUrl ?? "https://petstore.swagger.io/v2",
        instructions:
          "Use ctx.integrations.http.catalog for the static inbound MCP OpenAPI example. Call listOperations() before operation calls.",
        path: ["integrations", "http", "catalog"],
        specUrl: providerMatrixBaseUrl
          ? `${providerMatrixBaseUrl}/openapi.json`
          : "https://petstore.swagger.io/v2/swagger.json",
      }),
    );

    if (providerMatrixBaseUrl) {
      providers.push(
        createOutboundMcpFromOurClientToolProviderRegistration({
          instructions:
            "Use ctx.mcp.cloudflareDocs for the static inbound MCP outbound-MCP example. Call listTools() first.",
          path: ["mcp", "cloudflareDocs"],
          serverUrl: `${providerMatrixBaseUrl}/mcp`,
        }),
        createLoopbackServiceProviderRegistration({
          exportName: "TestBuiltinMatrixProvider",
          instructions:
            "Test-only provider that composes OpenAPI, outbound MCP, and a unary leaf provider through codemode context calls.",
          path: ["integrations", "builtinMatrix"],
        }),
        createLoopbackServiceProviderRegistration({
          exportName: "TestLeafProvider",
          instructions: "Test-only unary provider for inbound MCP provider composition proofs.",
          path: ["leaf"],
        }),
      );
    }

    return providers;
  }

  private async emitLifecycleEvent(slug: string, payload: Record<string, unknown>) {
    try {
      const streamPath = await this.getSessionStreamPath();
      const auth = this.requireAuthProps();
      if (!auth.projectId) {
        return;
      }

      await getStreamsCapability({
        exports: this.workerExports(),
        props: streamCapabilityProps({
          projectId: auth.projectId,
          streamPath,
        }),
      }).append({
        event: {
          type: `${eventTypePrefix}/${slug}`,
          idempotencyKey:
            slug === "session-started"
              ? `mcp-server:${this.getSessionId()}:session-started`
              : undefined,
          payload: {
            ...payload,
            mcpSessionId: this.getSessionId(),
            sessionSlug: await this.getSessionSlug(),
            streamPath,
          },
        } satisfies EventInput,
      });
    } catch (error) {
      console.error("[mcp-server] failed to append lifecycle event", {
        error,
        slug,
      });
    }
  }

  /** Returns the verified Clerk identity injected by the Worker before McpAgent dispatch. */
  private requireAuthProps() {
    if (!this.props?.userId || !this.props.orgId) {
      throw new Error("MCP request is missing verified Clerk auth props.");
    }

    return this.props;
  }

  /**
   * MCP tools are project-scoped. The ProjectMcpServerEntrypoint verifies Clerk
   * OAuth and asks the Project Durable Object for project access before this DO
   * sees a request, but this guard keeps tools from accidentally running with
   * only org-level auth if the routing layer changes.
   */
  private requireProjectAuthProps() {
    const auth = this.requireAuthProps();
    if (!auth.projectId) {
      throw new Error("MCP tools require a project-scoped MCP server host.");
    }

    return auth as ProjectMcpServerConnectionProps & { orgId: string; projectId: string };
  }

  private requireScope(props: ProjectMcpServerConnectionProps, scope: string) {
    if (props.clerkTokenType === "session_token" || props.clerkTokenType === "admin_api_secret") {
      return;
    }

    if (!props.scopes.includes(scope)) {
      throw new Error(`MCP token is missing required scope: ${scope}`);
    }
  }

  private workerExports() {
    return this.ctx.exports;
  }

  /** Stable event stream for lifecycle and codemode events emitted by one MCP session. */
  private async getSessionStreamPath() {
    return StreamPath.parse(`/mcp-server-sessions/${await this.getSessionSlug()}`);
  }

  private async getSessionSlug() {
    const existing = await this.ctx.storage.get<string>(sessionSlugStorageKey);
    if (existing) {
      return existing;
    }

    const rawClientName = (await this.getClientInfo())?.name;
    const clientName = typeof rawClientName === "string" ? rawClientName : "mcp-session";
    const base = slugifySegment(clientName) || "mcp-session";
    const suffix =
      slugifySegment(this.getSessionId()).slice(-12) || crypto.randomUUID().slice(0, 8);
    const sessionSlug = `${base}-${suffix}`;
    await this.ctx.storage.put(sessionSlugStorageKey, sessionSlug);
    return sessionSlug;
  }

  private async getClientInfo() {
    const initializeRequest = await this.getInitializeRequest();
    if (!isRecord(initializeRequest)) {
      return null;
    }

    if (!("params" in initializeRequest)) {
      return null;
    }

    const params = initializeRequest.params;
    if (!isRecord(params) || !isRecord(params.clientInfo)) {
      return null;
    }

    return params.clientInfo;
  }

  private async initializeCatalogRecord() {
    const auth = this.requireProjectAuthProps();
    const name = this.ctx.id.name;
    if (!name) {
      throw new Error("Inbound MCP server Durable Object must be addressed by name.");
    }

    const clientInfo = await this.getClientInfo();
    const rawClientName = isRecord(clientInfo) ? clientInfo.name : undefined;
    const structuredName = ProjectMcpServerConnectionStructuredName.parse({
      projectId: auth.projectId,
      projectSlug: auth.projectSlug,
      orgId: auth.orgId,
      orgSlug: auth.orgSlug,
      userId: auth.userId,
      clientId: auth.clientId,
      clientName: typeof rawClientName === "string" ? rawClientName : null,
      streamPath: await this.getSessionStreamPath(),
    });

    await upsertD1ObjectCatalog({
      db: this.env.DO_CATALOG,
      className: "ProjectMcpServerConnection",
      id: this.ctx.id.toString(),
      indexes: {
        orgId: (params) => params.orgId,
        projectId: (params) => params.projectId,
      },
      name,
      structuredName,
    });
  }
}

function debugCodemodeDepth(message: string, payload: Record<string, unknown>) {
  console.log("[DEBUG-cm-depth]", JSON.stringify({ message, ...payload }));
}

function readDebugProviderLimit(code: string) {
  const match = code.match(/providerLimit:(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function summarizeRequest(request: Request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathname: url.pathname,
    userAgent: request.headers.get("user-agent"),
  };
}

function summarizeAuthProps(props: ProjectMcpServerConnectionProps) {
  return {
    clientId: props.clientId,
    orgId: props.orgId,
    orgRole: props.orgRole,
    orgSlug: props.orgSlug,
    projectId: props.projectId,
    projectSlug: props.projectSlug,
    scopes: props.scopes,
    userId: props.userId,
  };
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function streamCapabilityProps(input: {
  projectId: string;
  streamPath: StreamPath;
}): StreamsCapabilityProps {
  return {
    appendPolicy: { mode: "stream" },
    projectId: input.projectId,
    streamPath: input.streamPath,
  };
}

function createLoopbackServiceProviderRegistration(input: {
  exportName: string;
  instructions: string;
  path: string[];
}): ToolProviderRegistration {
  return {
    instructions: input.instructions,
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: input.exportName,
          props: {},
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
    path: input.path,
  };
}

async function* decodeStreamEventLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel();
  };

  try {
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) yield JSON.parse(line) as Event;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as Event;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * Bridges the request/response shape expected by MCP tools onto CodemodeSession's
 * event stream. Codemode execution is asynchronous and durable; the MCP tool
 * waits for the matching `script-execution-completed` event instead of calling a
 * separate in-memory executor, so web UI code mode and inbound MCP share one
 * execution path.
 */
async function waitForScriptExecutionFinished(input: {
  afterOffset: number;
  exports: Cloudflare.Exports | undefined;
  projectId: string;
  scriptExecutionId: string;
  streamPath: StreamPath;
}) {
  const logs: string[] = [];
  const response = await getStreamsCapability({
    exports: input.exports,
    props: streamCapabilityProps({
      projectId: input.projectId,
      streamPath: input.streamPath,
    }),
  }).stream({
    afterOffset: input.afterOffset,
  });

  if (!response.body) {
    throw new Error("Codemode Script Execution stream response did not include a body.");
  }

  for await (const event of decodeStreamEventLines(response.body, AbortSignal.timeout(60_000))) {
    const payload = readEventPayload(event);
    if (
      event.type === "events.iterate.com/codemode/log-emitted" &&
      payload.scriptExecutionId === input.scriptExecutionId
    ) {
      const level = typeof payload.level === "string" ? payload.level : "log";
      const message = typeof payload.message === "string" ? payload.message : "";
      logs.push(`[${level}] ${message}`);
    }

    if (
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      payload.scriptExecutionId === input.scriptExecutionId
    ) {
      const outcome = isRecord(payload.outcome) ? payload.outcome : {};
      return {
        error: outcome.status === "threw" ? stringifyPayloadError(outcome.error) : undefined,
        logs,
        result: outcome.status === "returned" ? outcome.value : undefined,
      };
    }
  }

  throw new Error("Codemode Script Execution stream ended before a result event was appended.");
}

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** Health-check handler for direct worker invocations (not via DO). */
export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
