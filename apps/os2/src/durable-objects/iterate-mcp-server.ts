import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Connection } from "agents";
import { z } from "zod";
import { StreamPath, type Event, type EventInput } from "@iterate-com/events-contract";
import { createEventsClient } from "@iterate-com/events-contract/sdk";
import packageJson from "../../package.json" with { type: "json" };
import {
  type CodemodeSessionNamespace,
  startCodemodeScriptOnSession,
} from "~/codemode/codemode-session-rpc.ts";

/**
 * MCP server for os2, exposed at `/mcp` on project hostnames only.
 *
 * Runs as a Durable Object in a separate Worker (`iterate-mcp-server-do`).
 * `entry.workerd.ts` verifies Clerk OAuth, resolves the request hostname to a
 * project, and passes that identity into this Durable Object through McpAgent
 * props. That mirrors Cloudflare's documented OAuth integration point while
 * letting Clerk remain the authorization server:
 * https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/
 *
 * Code execution is delegated to the project/stream-scoped CodemodeSession DO.
 *
 * Tools:
 * - run_code: Execute JavaScript in an isolated dynamic worker sandbox
 * - reveal_secret: Return a dedicated deploy-time proof secret
 */

interface McpServerEnv {
  CODEMODE_SESSION: CodemodeSessionNamespace;
  EVENTS_BASE_URL: string;
  MCP_PROOF_SECRET: string;
  ITERATE_MCP_SERVER: DurableObjectNamespace;
}

export interface IterateMcpServerProps extends Record<string, unknown> {
  projectId: string | null;
  projectSlug: string | null;
  userId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[];
  scopes: string[];
  clientId: string | null;
}

const sessionSlugStorageKey = "mcpServerSessionSlug";
const eventTypePrefix = "events.iterate.com/mcp-server";
const requiredToolScope = "profile";
const mcpEventInputSchema = z
  .object({
    idempotencyKey: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    offset: z.number().int().positive().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    type: z.string(),
  })
  .strict();

export class IterateMcpServer extends McpAgent<McpServerEnv, unknown, IterateMcpServerProps> {
  server = new McpServer({
    name: "os2",
    version: packageJson.version,
  });

  async setInitializeRequest(initializeRequest: Parameters<McpAgent["setInitializeRequest"]>[0]) {
    await super.setInitializeRequest(initializeRequest);
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
    this.server.registerTool(
      "reveal_secret",
      {
        title: "Reveal secret",
        description:
          "Return the dedicated MCP proof secret configured on this deployment. " +
          "This is intentionally not a production credential.",
        inputSchema: z.object({}),
      },
      async () => {
        const invocationId = `mcp_tool_${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const auth = this.requireProjectAuthProps();
        this.requireScope(auth, requiredToolScope);

        await this.emitLifecycleEvent("tool-invocation-started", {
          auth: summarizeAuthProps(auth),
          input: {},
          invocationId,
          projectId: auth.projectId,
          projectSlug: auth.projectSlug,
          toolName: "reveal_secret",
        });

        const response = {
          content: [{ type: "text" as const, text: this.env.MCP_PROOF_SECRET }],
          isError: false,
        };

        await this.emitLifecycleEvent("tool-invocation-finished", {
          auth: summarizeAuthProps(auth),
          durationMs: Date.now() - startedAt,
          input: {},
          invocationId,
          output: response,
          projectId: auth.projectId,
          projectSlug: auth.projectSlug,
          result: this.env.MCP_PROOF_SECRET,
          toolName: "reveal_secret",
        });

        return response;
      },
    );

    this.server.registerTool(
      "run_code",
      {
        title: "Run code",
        description:
          "Execute JavaScript code in an isolated sandbox. " +
          "The final expression is returned as the result. " +
          'Example: console.log("hello"); 1 + 1',
        inputSchema: z.object({
          code: z.string().describe("JavaScript code to execute"),
          events: z
            .array(mcpEventInputSchema)
            .optional()
            .describe("Event inputs to append to the Codemode Session before executing code."),
        }),
      },
      async ({ code, events = [] }) => {
        const auth = this.requireProjectAuthProps();
        this.requireScope(auth, requiredToolScope);

        const invocationId = `mcp_tool_${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const streamPath = await this.getSessionStreamPath();

        await this.emitLifecycleEvent("tool-invocation-started", {
          auth: summarizeAuthProps(auth),
          input: { code, eventCount: events.length },
          invocationId,
          projectId: auth.projectId,
          projectSlug: auth.projectSlug,
          streamPath,
          toolName: "run_code",
        });

        try {
          const started = await startCodemodeScriptOnSession({
            code,
            events: events as EventInput[],
            namespace: this.env.CODEMODE_SESSION,
            projectId: auth.projectId,
            providers: [],
            streamPath,
          });
          const output = await waitForScriptExecutionFinished({
            eventsBaseUrl: this.env.EVENTS_BASE_URL,
            scriptExecutionRequestedOffset: started.event.offset,
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
            input: { code, eventCount: events.length },
            invocationId,
            output: response,
            projectId: auth.projectId,
            projectSlug: auth.projectSlug,
            result: output,
            scriptExecutionRequestedOffset: started.event.offset,
            streamPath,
            toolName: "run_code",
          });

          return response;
        } catch (error) {
          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            durationMs: Date.now() - startedAt,
            error: serializeError(error),
            input: { code, eventCount: events.length },
            invocationId,
            isError: true,
            projectId: auth.projectId,
            projectSlug: auth.projectSlug,
            streamPath,
            toolName: "run_code",
          });

          throw error;
        }
      },
    );
  }

  private async emitLifecycleEvent(slug: string, payload: Record<string, unknown>) {
    try {
      const streamPath = await this.getSessionStreamPath();
      const client = createEventsClient(this.env.EVENTS_BASE_URL);
      await client.append({
        path: streamPath,
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
   * MCP tools are project-scoped: clients connect to
   * `<project>.<project-host-base>/mcp`, not a global OS2 MCP endpoint. Keeping
   * this guard in the DO prevents future tools from accidentally running against
   * only org-level auth if the Worker routing changes.
   */
  private requireProjectAuthProps() {
    const auth = this.requireAuthProps();
    if (!auth.projectId || !auth.projectSlug) {
      throw new Error("MCP tools require a project hostname such as <project>.example.app.");
    }

    return auth as IterateMcpServerProps & { projectId: string; projectSlug: string };
  }

  private requireScope(props: IterateMcpServerProps, scope: string) {
    if (!props.scopes.includes(scope)) {
      throw new Error(`MCP token is missing required scope: ${scope}`);
    }
  }

  /** Stable event stream for lifecycle and codemode events emitted by one MCP session. */
  private async getSessionStreamPath() {
    const auth = this.requireAuthProps();
    const ownerPath = auth.projectId ? `/projects/${auth.projectId}` : `/orgs/${auth.orgId}`;
    return StreamPath.parse(`${ownerPath}/mcp-server-sessions/${await this.getSessionSlug()}`);
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
}

function summarizeRequest(request: Request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathname: url.pathname,
    userAgent: request.headers.get("user-agent"),
  };
}

function summarizeAuthProps(props: IterateMcpServerProps) {
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

/**
 * Bridges the request/response shape expected by MCP tools onto CodemodeSession's
 * event stream. Codemode execution is asynchronous and durable; the MCP tool
 * waits for the matching `script-execution-finished` event instead of calling a
 * separate in-memory executor, so web UI code mode and inbound MCP share one
 * execution path.
 */
async function waitForScriptExecutionFinished(input: {
  eventsBaseUrl: string;
  scriptExecutionRequestedOffset: number;
  streamPath: StreamPath;
}) {
  const client = createEventsClient(input.eventsBaseUrl);
  const stream = await client.stream(
    {
      afterOffset:
        input.scriptExecutionRequestedOffset > 1
          ? input.scriptExecutionRequestedOffset - 1
          : "start",
      path: input.streamPath,
    },
    { signal: AbortSignal.timeout(60_000) },
  );
  const logs: string[] = [];

  for await (const event of stream) {
    const payload = readPayload(event);
    if (
      event.type === "events.iterate.com/codemode/log-emitted" &&
      payload.scriptExecutionRequestedOffset === input.scriptExecutionRequestedOffset
    ) {
      const level = typeof payload.level === "string" ? payload.level : "log";
      const message = typeof payload.message === "string" ? payload.message : "";
      logs.push(`[${level}] ${message}`);
    }

    if (
      event.type === "events.iterate.com/codemode/script-execution-finished" &&
      payload.scriptExecutionRequestedOffset === input.scriptExecutionRequestedOffset
    ) {
      return {
        error: stringifyPayloadError(payload.error),
        logs,
        result: payload.result,
      };
    }
  }

  throw new Error("Codemode Script Execution stream ended before a result event was appended.");
}

function readPayload(event: Event) {
  return event.payload != null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

function stringifyPayloadError(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(value);
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
