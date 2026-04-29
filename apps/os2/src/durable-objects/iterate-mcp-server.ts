import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Connection } from "agents";
import { z } from "zod";
import { StreamPath, type EventInput } from "@iterate-com/events-contract";
import { createEventsClient } from "@iterate-com/events-contract/sdk";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import packageJson from "../../package.json" with { type: "json" };

/**
 * MCP server for os2, exposed at /mcp on the main worker.
 *
 * Runs as a Durable Object in a separate Worker (`iterate-mcp-server-do`)
 * with its own LOADER binding for sandboxed code execution.
 *
 * Tools:
 * - run_code: Execute JavaScript in an isolated dynamic worker sandbox
 * - reveal_secret: Return a dedicated deploy-time proof secret
 */

interface McpServerEnv {
  EVENTS_BASE_URL: string;
  LOADER: WorkerLoader;
  MCP_PROOF_SECRET: string;
  ITERATE_MCP_SERVER: DurableObjectNamespace;
}

export interface IterateMcpServerProps extends Record<string, unknown> {
  userId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[];
  scopes: string[];
  clientId: string | null;
}

const sessionSlugStorageKey = "mcpServerSessionSlug";
const eventTypePrefix = "https://events.iterate.com/mcp-server";
const requiredToolScope = "profile";

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
        const auth = this.requireAuthProps();
        this.requireScope(auth, requiredToolScope);

        await this.emitLifecycleEvent("tool-invocation-started", {
          auth: summarizeAuthProps(auth),
          input: {},
          invocationId,
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
        }),
      },
      async ({ code }) => {
        const auth = this.requireAuthProps();
        this.requireScope(auth, requiredToolScope);

        if (!this.env.LOADER) {
          return {
            content: [{ type: "text" as const, text: "LOADER binding not available" }],
            isError: true,
          };
        }

        const invocationId = `mcp_tool_${crypto.randomUUID()}`;
        const blockId = `cblk_mcp_${crypto.randomUUID().slice(0, 8)}`;
        const logs: string[] = [];
        const startedAt = Date.now();

        await this.emitLifecycleEvent("tool-invocation-started", {
          auth: summarizeAuthProps(auth),
          blockId,
          input: { code },
          invocationId,
          toolName: "run_code",
        });

        const executor = new CodemodeExecutor({ loader: this.env.LOADER });
        try {
          const result = await executor.execute({
            code,
            providers: [],
            blockId,
            onEvent: (event) => {
              if (event.type === "codemode-log-emitted") {
                logs.push(`[${event.level}] ${event.message}`);
              }
            },
          });

          const parts: string[] = [];
          if (logs.length > 0) parts.push(`Console:\n${logs.join("\n")}`);
          if (result.error) {
            parts.push(`Error: ${result.error}`);
          } else {
            parts.push(`Result: ${JSON.stringify(result.result, null, 2)}`);
          }

          const response = {
            content: [{ type: "text" as const, text: parts.join("\n\n") }],
            isError: !!result.error,
          };

          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            blockId,
            durationMs: Date.now() - startedAt,
            input: { code },
            invocationId,
            output: response,
            result,
            toolName: "run_code",
          });

          return response;
        } catch (error) {
          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            blockId,
            durationMs: Date.now() - startedAt,
            error: serializeError(error),
            input: { code },
            invocationId,
            isError: true,
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

  private requireAuthProps() {
    if (!this.props?.userId || !this.props.orgId) {
      throw new Error("MCP request is missing verified Clerk auth props.");
    }

    return this.props;
  }

  private requireScope(props: IterateMcpServerProps, scope: string) {
    if (!props.scopes.includes(scope)) {
      throw new Error(`MCP token is missing required scope: ${scope}`);
    }
  }

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
