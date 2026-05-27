import OpenAI from "openai";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import { ResponsesWSBase } from "openai/resources/responses/ws-base";
import { z } from "zod";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  deriveDurableObjectNameFromStructuredName,
  getInitializedDoStub,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessor } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor";
import { createAgentChatProcessor } from "@iterate-com/shared/stream-processors/agent-chat/implementation";
import { createAgentProcessor } from "@iterate-com/shared/stream-processors/agent/implementation";
import {
  type CloudflareAiProcessorDeps,
  createCloudflareAiProcessor,
} from "@iterate-com/shared/stream-processors/cloudflare-ai/implementation";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import {
  createOpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "@iterate-com/shared/stream-processors/openai-ws/implementation";
import { createJsonataReactorProcessor } from "@iterate-com/shared/stream-processors/jsonata-reactor/implementation";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import { StreamSocketFrame } from "@iterate-com/shared/streams/stream-socket-types";
import { STREAM_CHILD_STREAM_CREATED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { AppConfig } from "~/app.ts";
import {
  createCodemodeSession,
  startCodemodeScriptOnExistingSession,
} from "~/domains/codemode/codemode-session-rpc.ts";
import { createExampleCapabilityProviders } from "~/domains/codemode/example-provider-registrations.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import {
  type RepoDurableObject,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import { createGmailProviderRegistration } from "~/domains/google/gmail-provider-registration.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";
import {
  type WorkspaceDurableObject,
  type WorkspaceStructuredName,
} from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
import { defaultWorkspaceIdForCodemodeSession } from "~/domains/workspaces/entrypoints/workspace-provider-registration.ts";
import { stripArtifactTokenQuery } from "~/domains/repos/artifacts.ts";
import {
  DEFAULT_AGENT_LLM_PROVIDER,
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
  isSlackAgentPath,
  OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE,
  readAgentPathPrefixPresets,
  selectAgentSetupPreset,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import { buildProjectStreamViewerUrl } from "~/lib/stream-viewer-url.ts";

export const AGENTS_STREAM_PATH = StreamPath.parse("/agents");

export type AgentDurableObjectStructuredName = {
  agentPath: StreamPath;
  projectId: string;
};

const AgentDurableObjectStructuredName = z.object({
  agentPath: StreamPath,
  projectId: z.string().trim().min(1),
});

export function getAgentDurableObjectName(input: AgentDurableObjectStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: input,
  });
}

export type AgentDurableObjectEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  AI: CloudflareAiProcessorDeps["ai"];
  APP_CONFIG: string;
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  DO_CATALOG: D1Database;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDurableObject>;
};

const AGENT_ITERATE_CONFIG_DIR = "/iterate-config";
const AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH = `${AGENT_ITERATE_CONFIG_DIR}/.git/iterate-clone-complete`;

export type CloneIterateConfigRepoInput = {
  git: Awaited<ReturnType<WorkspaceDurableObject["cloudflareShellGit"]>>;
  repo: RepoInfo;
  workspace: DurableObjectStub<WorkspaceDurableObject>;
};

type AgentStreamApi = ProcessorStreamApi<{
  emits: readonly string[];
  events: Record<string, unknown>;
  processorDeps?: readonly unknown[];
}> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

const AgentLifecycleBase = createIterateDurableObjectBase<
  typeof AgentDurableObjectStructuredName,
  Pick<AgentDurableObjectEnv, "DO_CATALOG">
>({
  className: "AgentDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    agentPath: (params) => params.agentPath,
    projectId: (params) => params.projectId,
  },
  nameSchema: AgentDurableObjectStructuredName,
});

const AgentBase = withStreamProcessor<AgentDurableObjectStructuredName, AgentDurableObjectEnv>({
  streamApi(args) {
    return agentStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: StreamPath.parse(String(args.streamPath)),
    });
  },
})(AgentLifecycleBase);

export class AgentDurableObject extends AgentBase<AgentDurableObjectEnv> {
  #streamSocketMessageQueue = Promise.resolve();

  constructor(ctx: DurableObjectState, env: AgentDurableObjectEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async (params) => {
      if (params.agentPath === AGENTS_STREAM_PATH) {
        this.registerStreamProcessor(createJsonataReactorProcessor());
      } else {
        await this.ensureAgentSetupEvents(params);
        const llmProvider = await this.resolveLlmProvider(params);
        this.registerStreamProcessor(createAgentChatProcessor());
        this.registerStreamProcessor(
          createAgentProcessor({
            waitUntil: (promise) => this.waitUntilStreamProcessor(promise),
          }),
        );
        this.registerStreamProcessor(this.createLlmProcessor(llmProvider));
        await this.ensureAgentWorkspace(params);
        await this.ensureCodemodeSession(params);
      }
      await this.ensureAgentSubscription(params);
      await this.catchUpStreamProcessors({
        signal: AbortSignal.timeout(30_000),
        streamPath: params.agentPath,
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/stream-subscription") {
      const inheritedFetch = super.fetch;
      if (inheritedFetch == null) {
        return new Response("Not found", { status: 404 });
      }
      return await inheritedFetch.call(this, request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    await this.ensureStarted();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = streamProcessorWebSocketMessageToString(message);
    if (text == null) return;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const frame = StreamSocketFrame.safeParse(json);
    if (!frame.success || frame.data.type !== "event") return;
    const event = frame.data.event;

    const next = this.#streamSocketMessageQueue.then(async () => {
      try {
        await this.afterAppend({ event });
      } catch (error) {
        console.error("[os-agent] stream websocket event processing failed", {
          agentName: this.name,
          error,
          offset: event.offset,
          streamPath: event.streamPath,
          type: event.type,
        });
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to process stream event.",
          }),
        );
      }
    });
    this.#streamSocketMessageQueue = next.catch(() => {});
    await next;
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStartedOrInitializeFromRuntimeName();
    const state = await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
    await this.ensureChildAgentRunner(input.event);
    await this.handleAgentOutputAddedForCodemode(input.event);
    await this.handleCodemodeScriptExecutionCompleted(input.event);
    return state;
  }

  async getRuntimeState() {
    await this.ensureStarted();
    return this.getStreamProcessorRuntimeState();
  }

  async sendMessage(input: { message: string; channel?: string }) {
    const params = await this.ensureStarted();
    const event = await this.streamsEntrypoint(params.agentPath).append({
      event: {
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: {
          channel: parseAgentChatChannel(input.channel),
          content: input.message,
        },
      },
    });
    return { event };
  }

  async doThing(input: { label: string; value: number }) {
    await this.ensureStarted();
    return {
      agentName: this.name,
      label: input.label,
      value: input.value,
      doubled: input.value * 2,
    };
  }

  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    await this.ensureStarted();
    const providerName = input.providerPath.join(".");
    if (providerName === "debug") {
      return await this.createDebugSnapshot();
    }

    const functionName = input.functionPath.join(".");
    if (functionName !== "sendMessage") {
      throw new Error(`Unknown agent chat tool function chat.${functionName}`);
    }

    const message = parseChatToolMessage(input.args[0]);
    const event = await this.appendAssistantResponse({
      idempotencyKey: `agent-chat-tool:send-message:${input.functionCallId}`,
      message,
    });
    return { event };
  }

  private async ensureAgentSubscription(params: AgentDurableObjectStructuredName) {
    await this.ensureStreamProcessorWebSocketSubscription({
      bindingName: "AGENT",
      durableObjectName: this.name,
      fetchPath: "/stream-subscription",
      slug: `agent:${params.projectId}:${params.agentPath}`,
      streamPath: params.agentPath,
    });
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
  }

  private async ensureChildAgentRunner(event: Event) {
    if (event.type !== STREAM_CHILD_STREAM_CREATED_TYPE) return;

    const payload = event.payload as { childPath?: unknown };
    const childPath = StreamPath.safeParse(payload.childPath);
    if (!childPath.success) return;

    const name = getAgentDurableObjectName({
      agentPath: childPath.data,
      projectId: this.structuredName.projectId,
    });
    const stub = this.env.AGENT.getByName(name);
    await stub.initialize({ name });
  }

  private async ensureCodemodeSession(params: AgentDurableObjectStructuredName) {
    await createCodemodeSession({
      events: [],
      namespace: this.env.CODEMODE_SESSION,
      projectId: params.projectId,
      providers: this.createCodemodeToolProviders(params),
      streamPath: params.agentPath,
    });
  }

  private async ensureAgentWorkspace(params: AgentDurableObjectStructuredName) {
    const workspace = await this.getAgentWorkspace(params);

    if (await workspace.hasFile(AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH)) {
      return;
    }

    const repo = await this.getOrCreateIterateConfigRepo(params);
    const git = await workspace.cloudflareShellGit();

    if (await workspace.hasFile(`${AGENT_ITERATE_CONFIG_DIR}/.git/HEAD`)) {
      let cloneIsUsable = true;
      try {
        await git.status({ dir: AGENT_ITERATE_CONFIG_DIR });
      } catch {
        cloneIsUsable = false;
      }

      if (cloneIsUsable) {
        await workspace.writeFile({
          content: `${repo.slug}\n`,
          path: AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH,
        });
        return;
      }
    }

    await workspace.removePath({
      force: true,
      path: AGENT_ITERATE_CONFIG_DIR,
      recursive: true,
    });
    await this.cloneIterateConfigRepo({ git, repo, workspace });
    await workspace.writeFile({
      content: `${repo.slug}\n`,
      path: AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH,
    });
  }

  protected async cloneIterateConfigRepo(input: CloneIterateConfigRepoInput) {
    await input.git.clone({
      url: remoteWithToken({
        remote: input.repo.remote,
        token: input.repo.token,
      }),
      dir: AGENT_ITERATE_CONFIG_DIR,
      branch: input.repo.defaultBranch,
      depth: 1,
    });
  }

  private async getOrCreateIterateConfigRepo(
    params: AgentDurableObjectStructuredName,
  ): Promise<RepoInfo> {
    return await getReposCapability({
      exports: this.ctx.exports,
      props: { projectId: params.projectId },
    }).ensureIterateConfigInfo({ projectSlug: null });
  }

  private async getAgentWorkspace(params: AgentDurableObjectStructuredName) {
    return await getInitializedDoStub({
      allowCreate: true,
      namespace: this.env.WORKSPACE,
      name: agentWorkspaceName(params),
    });
  }

  private async ensureAgentSetupEvents(params: AgentDurableObjectStructuredName) {
    const streamApi = this.streamsEntrypoint(params.agentPath);
    const events = await streamApi.read({ afterOffset: "start", beforeOffset: "end" });
    const rootEvents = await this.streamsEntrypoint(AGENTS_STREAM_PATH).read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    const preset = selectAgentSetupPreset({
      agentPath: params.agentPath,
      presets: readAgentPathPrefixPresets(rootEvents),
    });
    const setupEvents =
      preset?.events ?? defaultAgentSetupEvents(DEFAULT_AGENT_LLM_PROVIDER, params.agentPath);
    const hasSetupPrompt = setupEvents.some(
      (event) => event.type === "events.iterate.com/agent/system-prompt-updated",
    );

    for (const [index, event] of setupEvents.entries()) {
      const idempotencyKey = `os-agent-setup:${normalizeIdempotencyKeyPart(
        preset?.basePath ?? "default",
      )}:${index}:${event.type}`;
      if (events.some((existingEvent) => existingEvent.idempotencyKey === idempotencyKey)) {
        continue;
      }
      if (preset == null && hasEquivalentDefaultSetupEvent({ event, existingEvents: events })) {
        continue;
      }
      await streamApi.append({
        event: {
          idempotencyKey,
          payload: event.payload,
          type: event.type,
        },
      });
    }

    const lastPrompt = [...events]
      .reverse()
      .find((event) => event.type === "events.iterate.com/agent/system-prompt-updated");
    const systemPromptPayload = lastPrompt?.payload as { systemPrompt?: unknown } | undefined;
    const systemPrompt =
      typeof systemPromptPayload?.systemPrompt === "string" ? systemPromptPayload.systemPrompt : "";
    if (
      !hasSetupPrompt &&
      (!systemPrompt || systemPrompt.includes("ctx.streams.append({ event:"))
    ) {
      await streamApi.append({
        event: {
          type: "events.iterate.com/agent/system-prompt-updated",
          idempotencyKey: "agent-default-system-prompt-v2",
          payload: {
            systemPrompt: defaultAgentSystemPrompt(params.agentPath),
          },
        },
      });
    }
  }

  private async handleAgentOutputAddedForCodemode(event: Event) {
    if (this.structuredName.agentPath === AGENTS_STREAM_PATH) return;
    if (event.type !== "events.iterate.com/agent/output-added") return;

    const payload = event.payload as { content?: unknown };
    if (typeof payload.content !== "string") return;

    const code = extractCodemodeScript(payload.content);
    if (code == null) return;

    await startCodemodeScriptOnExistingSession({
      code,
      events: [],
      namespace: this.env.CODEMODE_SESSION,
      projectId: this.structuredName.projectId,
      streamPath: this.structuredName.agentPath,
    });
  }

  private async handleCodemodeScriptExecutionCompleted(event: Event) {
    if (this.structuredName.agentPath === AGENTS_STREAM_PATH) return;
    if (event.type !== "events.iterate.com/codemode/script-execution-completed") return;

    const payload = event.payload as {
      outcome?: unknown;
      scriptExecutionId?: unknown;
    };
    const outcome = payload.outcome;
    if (outcome == null || typeof outcome !== "object") return;

    const status = "status" in outcome ? outcome.status : undefined;
    if (status === "returned") {
      const value = "value" in outcome ? outcome.value : undefined;
      if (value === undefined) return;
      await this.appendCodemodeCompletionInput({
        event,
        idempotencyKey: `agent-codemode-script-result:${String(payload.scriptExecutionId)}`,
        outcome: {
          status,
          value,
        },
      });
      return;
    }

    if (status === "threw") {
      const error = "error" in outcome ? outcome.error : "Unknown codemode error";
      await this.appendCodemodeCompletionInput({
        event,
        idempotencyKey: `agent-codemode-script-error:${String(payload.scriptExecutionId)}`,
        outcome: {
          error,
          status,
        },
      });
    }
  }

  private async createDebugSnapshot() {
    const project = await this.readDebugProjectInfo();
    const config = this.getAppConfig();
    const streamUrl = project?.slug
      ? buildProjectStreamViewerUrl({
          baseUrl: config.baseUrl,
          projectSlug: project.slug,
          streamPath: this.structuredName.agentPath,
        })
      : (config.baseUrl ?? "https://os.iterate.com");
    const snapshot = {
      project:
        project == null
          ? { id: this.structuredName.projectId }
          : {
              id: this.structuredName.projectId,
              organizationSlug: project.organizationSlug ?? undefined,
              slug: project.slug,
            },
      streamPath: this.structuredName.agentPath,
      streamUrl,
    };
    return formatDebugMessage(snapshot);
  }

  private async readDebugProjectInfo(): Promise<DebugProjectInfo | null> {
    try {
      const row = await this.env.DO_CATALOG.prepare(
        `select p.id, p.slug, pp.principal_id as organization_id
         from projects p
         left join project_permissions pp
           on pp.project_id = p.id
          and pp.principal_type = 'clerk_organization'
         where p.id = ?
         order by pp.created_at asc
         limit 1`,
      )
        .bind(this.structuredName.projectId)
        .first<{ id: string; slug: string; organization_id: string | null }>();
      if (row == null) return null;
      return {
        id: row.id,
        organizationId: row.organization_id ?? undefined,
        organizationSlug: null,
        slug: row.slug,
      };
    } catch (error) {
      console.error("[os-agent] failed to read project debug info", {
        agentName: this.name,
        error,
      });
      return null;
    }
  }

  private getAppConfig() {
    return parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: this.env as unknown as Record<string, unknown>,
    });
  }

  private async appendAssistantResponse(input: {
    channel?: string;
    idempotencyKey: string;
    message: string;
  }) {
    return await this.streamsEntrypoint(this.structuredName.agentPath).append({
      event: {
        type: "events.iterate.com/agent-chat/assistant-response-added",
        idempotencyKey: input.idempotencyKey,
        payload: {
          channel: parseAgentChatChannel(input.channel),
          message: input.message,
        },
      },
    });
  }

  private async appendCodemodeCompletionInput(input: {
    event: Event;
    idempotencyKey: string;
    outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
  }) {
    return await this.streamsEntrypoint(this.structuredName.agentPath).append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: input.idempotencyKey,
        payload: {
          content: codemodeCompletionInputBlock({
            event: input.event,
            outcome: input.outcome,
          }),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    });
  }

  private createAgentChatToolProvider(): ToolProviderRegistration {
    return {
      path: ["chat"],
      instructions:
        "Use ctx.chat.sendMessage({ message }) to send a visible response to the user. Prefer this over appending chat events manually.",
      invocation: {
        kind: "rpc",
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "AGENT",
            durableObject: {
              name: this.name,
            },
          },
          rpcMethod: "executeCodemodeFunctionCall",
          argsMode: "object",
        },
      },
    };
  }

  private createAgentDebugToolProvider(): ToolProviderRegistration {
    return {
      path: ["debug"],
      instructions:
        "Use ctx.debug() to return OS debug information about the current agent stream.",
      invocation: {
        kind: "rpc",
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "AGENT",
            durableObject: {
              name: this.name,
            },
          },
          rpcMethod: "executeCodemodeFunctionCall",
          argsMode: "object",
        },
      },
    };
  }

  private createCodemodeToolProviders(
    params: AgentDurableObjectStructuredName,
  ): ToolProviderRegistration[] {
    return [
      ...(isSlackAgentPath(params.agentPath) ? [] : [this.createAgentChatToolProvider()]),
      this.createAgentDebugToolProvider(),
      ...createExampleCapabilityProviders({ projectId: params.projectId }),
      createGmailProviderRegistration({ projectId: params.projectId }),
    ];
  }

  private async resolveLlmProvider(
    params: AgentDurableObjectStructuredName,
  ): Promise<AgentLlmProvider> {
    const rootEvents = await this.streamsEntrypoint(AGENTS_STREAM_PATH).read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    const preset = selectAgentSetupPreset({
      agentPath: params.agentPath,
      presets: readAgentPathPrefixPresets(rootEvents),
    });
    const presetProvider = preset?.events
      .toReversed()
      .map((event) => (event.payload as { provider?: unknown }).provider)
      .find((provider) => provider === "cloudflare-ai" || provider === "openai-ws");
    if (presetProvider === "cloudflare-ai" || presetProvider === "openai-ws") {
      return presetProvider;
    }

    const events = await this.streamsEntrypoint(params.agentPath).read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    for (const event of events.toReversed()) {
      if (event.type !== OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE) continue;
      const provider = (event.payload as { provider?: unknown }).provider;
      if (provider === "cloudflare-ai" || provider === "openai-ws") return provider;
    }
    return DEFAULT_AGENT_LLM_PROVIDER;
  }

  private createLlmProcessor(provider: AgentLlmProvider) {
    if (provider === "cloudflare-ai") {
      return createCloudflareAiProcessor({
        ai: this.env.AI,
      });
    }

    const apiKey = readOpenAiApiKey(this.env as Record<string, unknown>);
    if (apiKey.trim() !== "") {
      return createOpenAiWsProcessor({
        openResponsesWebSocket: async () =>
          createOpenAiResponsesWebSocketClient(new OpenAI({ apiKey })),
      });
    }

    return createCloudflareAiProcessor({
      ai: this.env.AI,
    });
  }

  private streamsEntrypoint(streamPath: StreamPath) {
    return agentStreamApiFromNamespace({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      streamPath,
    });
  }
}

function streamProcessorWebSocketMessageToString(message: string | ArrayBuffer): string | null {
  if (typeof message === "string") return message;
  return new TextDecoder().decode(message);
}

function normalizeIdempotencyKeyPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, "-");
}

function hasEquivalentDefaultSetupEvent(input: {
  event: { type: string };
  existingEvents: readonly { payload: unknown; type: string }[];
}) {
  if (input.event.type === "events.iterate.com/agent/system-prompt-updated") {
    return input.existingEvents.some((event) => {
      if (event.type !== input.event.type) return false;
      const systemPrompt = (event.payload as { systemPrompt?: unknown }).systemPrompt;
      return (
        typeof systemPrompt === "string" && !systemPrompt.includes("ctx.streams.append({ event:")
      );
    });
  }
  return input.existingEvents.some((event) => event.type === input.event.type);
}

function readOpenAiApiKey(env: Record<string, unknown>) {
  const override = env.APP_CONFIG_OPEN_AI_API_KEY;
  if (typeof override === "string") return override;

  const rawConfig = env.APP_CONFIG;
  if (typeof rawConfig !== "string" || rawConfig.trim() === "") return "";

  try {
    const parsed = JSON.parse(rawConfig) as { openAiApiKey?: unknown };
    return typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "";
  } catch {
    return "";
  }
}

function agentStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): AgentStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event);
    },
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: input.afterOffset,
        before: input.beforeOffset ?? "end",
      });
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("Agent processors receive live events through afterAppend RPC.");
    },
  };
}

function resolveProcessorStreamPath(input: { basePath: StreamPath; pathInput?: string }) {
  if (input.pathInput == null) {
    return input.basePath;
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return resolveStreamPath(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}

function agentWorkspaceName(params: AgentDurableObjectStructuredName): WorkspaceStructuredName {
  return {
    projectId: params.projectId,
    workspaceId: defaultWorkspaceIdForCodemodeSession({ streamPath: params.agentPath }),
  };
}

function remoteWithToken(input: { remote: string; token: string }) {
  const url = new URL(input.remote);
  url.username = "x";
  url.password = stripArtifactTokenQuery(input.token);
  return url.toString();
}

const CODEMODE_FENCE_RE =
  /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)(?:\n```\s*)?$/;

function extractCodemodeScript(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("async (ctx) => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  if (trimmed.startsWith("async () => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = CODEMODE_FENCE_RE.exec(trimmed);
  return fenced?.[1]?.trim() || null;
}

function formatCodemodeOutput(output: unknown) {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

function codemodeCompletionInputBlock(input: {
  event: Event;
  outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
}) {
  const scriptExecutionId = (input.event.payload as { scriptExecutionId?: unknown })
    .scriptExecutionId;
  return [
    "```yaml",
    "event:",
    `  offset: ${input.event.offset}`,
    "  type: events.iterate.com/codemode/script-execution-completed",
    ...(typeof scriptExecutionId === "string"
      ? [`  scriptExecutionId: ${yamlScalar(scriptExecutionId)}`]
      : []),
    "  outcome:",
    `    status: ${input.outcome.status}`,
    ...yamlBlockScalar(
      input.outcome.status === "returned" ? "    value" : "    error",
      formatCodemodeOutput(
        input.outcome.status === "returned" ? input.outcome.value : input.outcome.error,
      ),
    ),
    "```",
  ].join("\n");
}

function parseAgentChatChannel(channel: string | undefined) {
  return channel === "tui" ? "tui" : "web";
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(key: string, value: string): string[] {
  return [`${key}: |-`, ...value.split("\n").map((line) => `      ${line}`)];
}

type DebugProjectInfo = {
  id: string;
  organizationId?: string;
  organizationSlug?: string | null;
  slug: string;
};

type DebugSnapshot = {
  project: { id: string; organizationSlug?: string; slug?: string };
  streamPath: string;
  streamUrl: string;
};

function formatDebugMessage(snapshot: DebugSnapshot) {
  return [
    `*Debug:* <${snapshot.streamUrl}|open stream>`,
    `Path: \`${snapshot.streamPath}\``,
    `Project: \`${snapshot.project.slug ?? snapshot.project.id}\``,
    snapshot.project.organizationSlug
      ? `Organization: \`${snapshot.project.organizationSlug}\``
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function parseChatToolMessage(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ctx.chat.sendMessage requires an object argument.");
  }
  const message = (value as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error("ctx.chat.sendMessage requires a non-empty message string.");
  }
  return message;
}

type CloudflareSocketEventName = "open" | "message" | "close" | "error" | string;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

function createOpenAiResponsesWebSocketClient(client: OpenAI): OpenAiResponsesWebSocket {
  const sdkWebSocket = new CloudflareResponsesWebSocket(client);

  return {
    get url() {
      return sdkWebSocket.url;
    },
    get socket() {
      return sdkWebSocket.socket;
    },
    send(event) {
      sdkWebSocket.send(event as unknown as ResponsesClientEvent);
    },
    stream() {
      return streamOpenAiResponsesWebSocket(sdkWebSocket);
    },
    close(props) {
      sdkWebSocket.close(props);
    },
  };
}

async function* streamOpenAiResponsesWebSocket(
  sdkWebSocket: CloudflareResponsesWebSocket,
): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
  for await (const event of sdkWebSocket.stream()) {
    switch (event.type) {
      case "connecting":
      case "open":
      case "closing":
      case "reconnected":
        yield { type: event.type };
        break;
      case "close":
        yield { type: "close", code: event.code, reason: event.reason };
        break;
      case "reconnecting":
        yield { type: "reconnecting", reconnect: toJsonValue(event.reconnect) };
        break;
      case "message":
        yield { type: "message", message: toJsonValue(event.message) };
        break;
      case "raw":
        yield { type: "raw", data: event.data };
        break;
      case "error":
        yield { type: "error", error: event.error };
        break;
      default:
        event satisfies never;
    }
  }
}

function toJsonValue(value: unknown): JsonValue {
  return z.json().parse(value);
}

class CloudflareResponsesWebSocket extends ResponsesWSBase<CloudflareFetchWebSocket> {
  constructor(client: OpenAI) {
    super(client, { reconnect: null });
    this._connectInitial();
  }

  protected _createSocket(url: URL, authHeaders: Record<string, string>): CloudflareFetchWebSocket {
    return new CloudflareFetchWebSocket(url, {
      ...authHeaders,
      "OpenAI-Beta": "responses_websockets=2026-02-06",
    });
  }
}

class CloudflareFetchWebSocket {
  #listeners = new Map<CloudflareSocketEventName, Set<unknown>>();
  #onceListeners = new Map<CloudflareSocketEventName, Map<unknown, unknown>>();
  #readyState = 0;
  #socket: WebSocket | undefined;

  constructor(
    private readonly url: URL,
    private readonly authHeaders: Record<string, string>,
  ) {
    void this.#connect();
  }

  get readyState(): number {
    return this.#socket?.readyState ?? this.#readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.#socket == null) throw new Error("OpenAI WebSocket is not open.");
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#readyState = 2;
    this.#socket?.close(code, reason);
  }

  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  on(event: CloudflareSocketEventName, listener: unknown): void {
    this.#listenersFor(event).add(listener);
  }

  off(event: "open", listener: () => void): void;
  off(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  off(event: "close", listener: (code: number, reason: string) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  off(event: CloudflareSocketEventName, listener: unknown): void {
    this.#removeListener(event, listener);
  }

  once(event: "open", listener: () => void): void;
  once(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  once(event: "close", listener: (code: number, reason: string) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  once(event: CloudflareSocketEventName, listener: unknown): void {
    const onceListener = (...args: never[]) => {
      this.#removeListener(event, listener);
      (listener as (...args: never[]) => void)(...args);
    };
    this.#onceListenersFor(event).set(listener, onceListener);
    this.on(event, onceListener);
  }

  get socket(): { readonly readyState: number } {
    return { readyState: this.readyState };
  }

  async #connect() {
    try {
      const response = (await fetch(this.url.toString().replace("wss://", "https://"), {
        headers: {
          ...this.authHeaders,
          Upgrade: "websocket",
        },
      })) as Response & { webSocket?: WebSocket | null };

      if (response.webSocket == null) {
        throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
      }

      this.#socket = response.webSocket;
      this.#socket.accept();
      this.#bindSocket(this.#socket);
      this.#readyState = this.#socket.readyState;
      this.#emit("open");
    } catch (error) {
      this.#readyState = 3;
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      this.#emit("close", 1006, "OpenAI WebSocket upgrade failed.");
    }
  }

  #bindSocket(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.#emit("message", event.data, event.data instanceof ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      this.#readyState = 3;
      this.#emit("close", event.code, event.reason);
    });
    socket.addEventListener("error", () => {
      this.#emit("error", new Error("OpenAI WebSocket errored."));
    });
  }

  #listenersFor(event: CloudflareSocketEventName): Set<unknown> {
    const existing = this.#listeners.get(event);
    if (existing != null) return existing;

    const listeners = new Set<unknown>();
    this.#listeners.set(event, listeners);
    return listeners;
  }

  #onceListenersFor(event: CloudflareSocketEventName): Map<unknown, unknown> {
    const existing = this.#onceListeners.get(event);
    if (existing != null) return existing;

    const listeners = new Map<unknown, unknown>();
    this.#onceListeners.set(event, listeners);
    return listeners;
  }

  #removeListener(event: CloudflareSocketEventName, listener: unknown) {
    const listeners = this.#listeners.get(event);
    listeners?.delete(listener);
    const onceListener = this.#onceListeners.get(event)?.get(listener);
    if (onceListener == null) return;
    listeners?.delete(onceListener);
    this.#onceListeners.get(event)?.delete(listener);
  }

  #emit(event: CloudflareSocketEventName, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (...args: unknown[]) => void)(...args);
    }
  }
}
