import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Connection } from "agents";
import { z } from "zod";
import { StreamPath, type EventInput } from "@iterate-com/shared/streams/types";
import { upsertD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import packageJson from "../../../../package.json" with { type: "json" };
import {
  getStreamsBackend,
  type StreamsBackendProps,
} from "~/domains/streams/entrypoints/streams-backend.ts";
import type { ItxDurableObject } from "~/itx/itx-durable-object.ts";
import type { CapabilityAddress } from "~/itx/itx.ts";
import {
  contextAddress,
  createContext,
  dialContext,
  formatContextRef,
  projectContextRef,
} from "~/itx/coordinates.ts";
import type { ItxRuntime } from "~/itx/handle.ts";
import { runItxScript } from "~/itx/run.ts";

export { StreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";

/**
 * Project-scoped MCP server connection for os.
 *
 * Runs as a Durable Object in the MCP worker (`workers/mcp.ts`), whose fetch
 * handler verifies Iterate Auth OAuth, resolves the token's project
 * grants, and passes that identity into this Durable Object through McpAgent
 * props. That mirrors Cloudflare's documented OAuth integration point:
 * https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/
 *
 * Code execution runs through the shared itx runner (src/itx/run.ts).
 *
 * Tools:
 * - exec_js: Execute JavaScript in an isolated dynamic worker sandbox
 */

interface McpServerEnv {
  DO_CATALOG: D1Database;
  ITX_CONTEXT: DurableObjectNamespace<ItxDurableObject>;
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
  authType?: "admin_api_secret" | "oauth_access_token" | "session";
  projects?: ProjectMcpServerConnectionProject[];
}

export interface ProjectMcpServerConnectionProject {
  id: string;
  slug: string;
  organizationId: string;
  organizationSlug: string | null;
  organizationRole: string | null;
  organizationPermissions: string[];
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

/** Bump when SEEDED_CAPS changes; existing sessions re-seed on next call. */
const MCP_CONTEXT_CAPS_VERSION = "2";

/** Capabilities every MCP session context starts with (instructions feed the
 * exec_js tool description AND itx describe()). */
const SEEDED_CAPS: Array<{
  name: string;
  instructions: string;
  capability: CapabilityAddress;
}> = [
  {
    instructions:
      "Workers AI. itx.ai.run(model, input) — e.g. itx.ai.run('@cf/meta/llama-3.1-8b-instruct', { prompt: '…' }).",
    name: "ai",
    capability: { type: "rpc", worker: { binding: "AI", type: "binding" } },
  },
  {
    instructions:
      "Gmail for this project's connected Google account. itx.gmail.request({ path, method?, query?, body? }) against the Gmail REST API.",
    name: "gmail",
    capability: { entrypoint: "GmailCapability", type: "rpc", worker: { type: "loopback" } },
  },
];

export class ProjectMcpServerConnection extends McpAgent<
  McpServerEnv,
  unknown,
  ProjectMcpServerConnectionProps
> {
  server = new McpServer(
    {
      name: "os",
      version: packageJson.version,
    },
    {
      instructions: [
        "This is an Iterate OS project MCP server. You have one tool: exec_js.",
        "",
        "exec_js runs JavaScript in an isolated sandbox. The code MUST be a single async arrow function: `async (itx) => { ... }` — the one argument is your iterate context handle.",
        "",
        "The `itx` object is a handle on this session's iterate context: built-ins (itx.fetch, itx.streams, itx.provideCapability) plus every capability on the context, called as `itx.<cap>.<method>(args)`. Available capabilities are listed in the exec_js tool description.",
        "",
        "Use `Promise.all([...])` for concurrent operations. Use `fetch` for HTTP requests (it rides project egress with secret substitution). The return value is sent back as the result. Do NOT write bare statements — always wrap in `async (itx) => { ... }`.",
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
    const auth = this.requireAuthProps();
    const availableProjects = this.resolveAvailableProjects(auth);
    const requireProjectInput =
      auth.authType === "admin_api_secret" || availableProjects.length > 1;
    const schema = this.createExecJsInputSchema(availableProjects, { requireProjectInput });
    const providerDocs = SEEDED_CAPS.map((cap) => `- itx.${cap.name}: ${cap.instructions}`).join(
      "\n",
    );

    this.server.registerTool(
      "exec_js",
      {
        title: "Run code",
        description: [
          "Execute JavaScript in an isolated sandbox. The code MUST be a single async arrow function: `async (itx) => { ... }`.",
          "",
          "The function receives `itx`, a handle on this session's iterate context. Use `Promise.all([...])` for concurrent operations. Use `fetch` for HTTP (project egress, secret substitution). The return value (or thrown error) is sent back as the tool result.",
          "Return a value only when you need to inspect it in the tool result. For side-effect-only calls, await the call but do not return its result.",
          "",
          "Available capabilities on itx:",
          providerDocs,
          "",
          'Example: async (itx) => { const msgs = await itx.gmail.request({ path: "/gmail/v1/users/me/messages", query: { maxResults: 5 } }); return msgs.data; }',
        ].join("\n"),
        inputSchema: schema,
      },
      async (input) => {
        const parsedInput = schema.parse(input);
        const code = parsedInput.code;
        const project = typeof parsedInput.project === "string" ? parsedInput.project : undefined;
        const auth = this.authForProject(
          this.requireAuthProps(),
          this.resolveToolProject(availableProjects, project, { requireProjectInput }),
        );
        this.requireScope(auth, requiredToolScope);

        const invocationId = `mcp_tool_${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const streamPath = await this.getSessionStreamPath();

        await this.emitLifecycleEvent("tool-invocation-started", {
          auth: summarizeAuthProps(auth),
          input: { code },
          invocationId,
          projectId: auth.projectId,
          projectSlug: auth.projectSlug,
          streamPath,
          toolName: "exec_js",
        });

        try {
          const itxContextId = await this.ensureItxContext(auth.projectId);
          const outcome = await runItxScript({
            env: this.env as unknown as Env,
            exports: this.workerExports() as unknown as ItxRuntime["exports"],
            functionSource: code,
            projectId: auth.projectId,
            props: { context: itxContextId },
            record: { namespace: auth.projectId, path: streamPath },
          });

          const parts: string[] = [];
          if (outcome.logs.length > 0) parts.push(`Console:\n${outcome.logs.join("\n")}`);
          if (outcome.ok) {
            parts.push(`Result: ${JSON.stringify(outcome.result, null, 2)}`);
          } else {
            parts.push(`Error: ${outcome.error}`);
          }

          const response = {
            content: [{ type: "text" as const, text: parts.join("\n\n") }],
            isError: !outcome.ok,
          };

          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            durationMs: Date.now() - startedAt,
            executionId: outcome.executionId,
            input: { code },
            invocationId,
            output: response,
            projectId: auth.projectId,
            projectSlug: auth.projectSlug,
            streamPath,
            toolName: "exec_js",
          });

          return response;
        } catch (error) {
          await this.emitLifecycleEvent("tool-invocation-finished", {
            auth: summarizeAuthProps(auth),
            durationMs: Date.now() - startedAt,
            error: serializeError(error),
            input: { code },
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

  /**
   * One child context per (MCP session, project): its coordinate IS the
   * session's stream — the session's capabilities live on it, scripts run
   * against it, and anything it doesn't define delegates up to the project
   * context (the itx prototype chain).
   */
  private async ensureItxContext(projectId: string): Promise<string> {
    // Single-flight per project: concurrent exec_js calls must not race the
    // storage get/put into minting two context ids.
    const inflight = this.#ensureItxContextPromises.get(projectId);
    if (inflight) return await inflight;
    const promise = this.#ensureItxContextOnce(projectId).finally(() => {
      this.#ensureItxContextPromises.delete(projectId);
    });
    this.#ensureItxContextPromises.set(projectId, promise);
    return await promise;
  }

  readonly #ensureItxContextPromises = new Map<string, Promise<string>>();

  async #ensureItxContextOnce(projectId: string): Promise<string> {
    const streamPath = await this.getSessionStreamPath();
    const ref = formatContextRef({ namespace: projectId, path: streamPath });
    const versionKey = `itxContextCapsVersion:${projectId}`;
    const seededVersion = await this.ctx.storage.get<string>(versionKey);
    if (seededVersion === MCP_CONTEXT_CAPS_VERSION) return ref;

    // The session context's coordinate IS the session stream. Creation is
    // the standard two appends (subscription + creation event) — re-creates
    // are inert, so a caps-version bump just re-provides onto the same node.
    const created = await createContext({
      env: this.env as unknown as Env,
      name: `mcp:${await this.getSessionSlug()}`,
      namespace: projectId,
      parent: {
        address: contextAddress(projectContextRef(projectId)),
        ref: projectContextRef(projectId),
      },
      path: streamPath,
    });
    const contextItx = dialContext(this.env as unknown as Env, created.address).itx();
    for (const cap of SEEDED_CAPS) {
      await contextItx.provideCapability({
        instructions: cap.instructions,
        name: cap.name,
        capability: cap.capability,
      });
    }
    await this.ctx.storage.put(versionKey, MCP_CONTEXT_CAPS_VERSION);
    return ref;
  }

  private async emitLifecycleEvent(slug: string, payload: Record<string, unknown>) {
    try {
      const streamPath = await this.getSessionStreamPath();
      const auth = this.requireAuthProps();
      const projectId =
        typeof payload.projectId === "string"
          ? payload.projectId
          : (auth.projectId ?? this.resolveAvailableProjects(auth)[0]?.id);
      if (!projectId) {
        return;
      }

      await getStreamsBackend({
        exports: this.workerExports(),
        props: streamCapabilityProps({
          projectId,
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

  /** Returns the verified identity injected by the Worker before McpAgent dispatch. */
  private requireAuthProps() {
    if (!this.props?.userId || !this.props.orgId) {
      throw new Error("MCP request is missing verified auth props.");
    }

    return this.props;
  }

  /**
   * MCP tools are project-scoped. The request layer verifies Iterate Auth OAuth
   * and passes the token's project grants before this DO sees a request, but
   * this guard keeps tools from accidentally running with only org-level auth if
   * the routing layer changes.
   */
  private requireScope(props: ProjectMcpServerConnectionProps, scope: string) {
    if (props.authType === "session" || props.authType === "admin_api_secret") {
      return;
    }

    if (!props.scopes.includes(scope)) {
      throw new Error(`MCP token is missing required scope: ${scope}`);
    }
  }

  private workerExports() {
    return this.ctx.exports;
  }

  /** Stable event stream for lifecycle events emitted by one MCP session. */
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
    const auth = this.authForProject(
      this.requireAuthProps(),
      this.resolveAvailableProjects(this.requireAuthProps())[0],
    );
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

  private resolveAvailableProjects(
    auth: ProjectMcpServerConnectionProps,
  ): ProjectMcpServerConnectionProject[] {
    const projects = auth.projects ?? [];
    if (projects.length > 0) return projects;

    if (auth.projectId && auth.orgId) {
      return [
        {
          id: auth.projectId,
          slug: auth.projectSlug ?? auth.projectId,
          organizationId: auth.orgId,
          organizationPermissions: auth.orgPermissions,
          organizationRole: auth.orgRole,
          organizationSlug: auth.orgSlug,
        },
      ];
    }

    throw new Error("MCP token does not grant access to any projects.");
  }

  private createExecJsInputSchema(
    projects: ProjectMcpServerConnectionProject[],
    options: { requireProjectInput: boolean },
  ) {
    const projectSlugs = Array.from(new Set(projects.map((project) => project.slug))).sort();

    return z.object({
      code: z
        .string()
        .describe(
          "JavaScript async arrow function to execute. Return a value only when you need to inspect it, e.g. `async (itx) => { return await itx.describe(); }`",
        ),
      ...(options.requireProjectInput
        ? {
            project: z
              .enum(projectSlugs as [string, ...string[]])
              .describe("Project slug to run this code against."),
          }
        : {}),
    });
  }

  private resolveToolProject(
    projects: ProjectMcpServerConnectionProject[],
    requestedProject: string | undefined,
    options: { requireProjectInput: boolean },
  ) {
    if (!options.requireProjectInput && !requestedProject) {
      return projects[0];
    }

    const normalizedRequestedProject = requestedProject?.trim();
    if (!normalizedRequestedProject) {
      throw new Error("Pass a project slug.");
    }

    const project = projects.find((candidate) => candidate.slug === normalizedRequestedProject);
    if (!project) {
      throw new Error(`MCP token does not grant access to project: ${normalizedRequestedProject}`);
    }

    return project;
  }

  private authForProject(
    auth: ProjectMcpServerConnectionProps,
    project: ProjectMcpServerConnectionProject,
  ): ProjectMcpServerConnectionProps & { orgId: string; projectId: string } {
    return {
      ...auth,
      orgId: project.organizationId,
      orgPermissions: project.organizationPermissions,
      orgRole: project.organizationRole,
      orgSlug: project.organizationSlug,
      projectId: project.id,
      projectSlug: project.slug,
    };
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
}): StreamsBackendProps {
  return {
    appendPolicy: { mode: "stream" },
    projectId: input.projectId,
    streamPath: input.streamPath,
  };
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
