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
import { AgentChatProcessorContract } from "@iterate-com/shared/stream-processors/agent-chat/contract";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import type { CloudflareAiProcessorDeps } from "@iterate-com/shared/stream-processors/cloudflare-ai/implementation";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import {
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "@iterate-com/shared/stream-processors/openai-ws/implementation";
import { JsonataReactorProcessorContract } from "@iterate-com/shared/stream-processors/jsonata-reactor/contract";
import type { ProcessorStreamApi } from "@iterate-com/shared/stream-processors";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";
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
import {
  AGENT_HOST_PROCESSOR_SLUG,
  agentLlmProcessorSlug,
  agentProcessorRunnerName,
  agentProcessorSubscriptionConfiguredEvents,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { buildProjectStreamViewerUrl } from "~/lib/stream-viewer-url.ts";
import type { StreamProcessorRunner } from "~/domains/streams/durable-objects/stream-processor-runner.ts";

export {
  AGENT_HOST_PROCESSOR_SLUG,
  agentLlmProcessorSlug,
  agentProcessorRunnerName,
  agentProcessorSubscriptionKey,
} from "~/domains/agents/agent-stream-subscriptions.ts";

export const AGENTS_STREAM_PATH = StreamPath.parse("/agents");

// Core lifecycle event types emitted by the @iterate-com/streams runtime. These use the
// `events.iterate.com/stream/` prefix (NOT the legacy `@iterate-com/shared/streams` `/core/`
// prefix, which never matches new-runtime events).
const STREAM_CREATED_TYPE = "events.iterate.com/stream/created";
const STREAM_CHILD_STREAM_CREATED_TYPE = "events.iterate.com/stream/child-stream-created";

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
  STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<StreamProcessorRunner>;
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

export class AgentDurableObject extends AgentLifecycleBase<AgentDurableObjectEnv> {
  constructor(ctx: DurableObjectState, env: AgentDurableObjectEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async (params) => {
      if (params.agentPath === AGENTS_STREAM_PATH) {
        await this.ensureAgentSubscriptions(params, [
          JsonataReactorProcessorContract.slug,
          AGENT_HOST_PROCESSOR_SLUG,
        ]);
      } else {
        await this.ensureAgentSetupEvents(params);
        const llmProvider = await this.resolveLlmProvider(params);
        this.ctx.waitUntil(
          this.ensureAgentWorkspace(params).catch((error) => {
            console.error("[agent-workspace-setup] failed", error);
          }),
        );
        await this.ensureAgentSubscriptions(params, [
          AgentChatProcessorContract.slug,
          AgentProcessorContract.slug,
          agentLlmProcessorSlug(llmProvider),
          AGENT_HOST_PROCESSOR_SLUG,
        ]);
        await this.ensureCodemodeSession(params);
      }
      await this.waitForAgentProcessorsCatchUp(params);
    });
  }

  async afterAppend(input: { event: Event }) {
    void input;
    await this.ensureStartedOrInitializeFromRuntimeName();
    await this.waitForAgentProcessorsCatchUp(this.structuredName);
    return await this.getRuntimeState();
  }

  async getRuntimeState() {
    const params = await this.ensureStarted();
    return await this.getAgentRuntimeState(params);
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

  private async ensureAgentSubscriptions(
    params: AgentDurableObjectStructuredName,
    processorSlugs: readonly string[],
  ) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: params.agentPath,
    });

    await stream.appendBatch(
      agentProcessorSubscriptionConfiguredEvents({
        agentPath: params.agentPath,
        processorSlugs,
        projectId: params.projectId,
      }),
    );
  }

  private async waitForAgentProcessorsCatchUp(params: AgentDurableObjectStructuredName) {
    const maxOffset = await this.currentStreamMaxOffset(params);
    const processorSlugs = await this.agentProcessorSlugs(params);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const states = await Promise.all(
        processorSlugs.map((processorSlug) =>
          this.getAgentProcessorRunnerState(params, processorSlug),
        ),
      );
      if (states.every((state) => state.reducedThroughOffset >= maxOffset)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async getAgentRuntimeState(params: AgentDurableObjectStructuredName) {
    const processorSlugs = await this.agentProcessorSlugs(params);
    const states = await Promise.all(
      processorSlugs.map(async (processorSlug) => ({
        processorSlug,
        state: await this.getAgentProcessorRunnerState(params, processorSlug),
      })),
    );
    return {
      entries: states.map(({ processorSlug, state }) => ({
        afterAppendCompletedThroughOffset: state.afterAppendCompletedThroughOffset,
        processorSlug,
        reducedThroughOffset: state.reducedThroughOffset,
        streamPath: String(params.agentPath),
      })),
      lastAppendDeliveryDelays: [],
      pendingWaitUntilCount: 0,
      registeredProcessors: processorSlugs,
      runners: Object.fromEntries(states.map(({ processorSlug, state }) => [processorSlug, state])),
    };
  }

  private async agentProcessorSlugs(params: AgentDurableObjectStructuredName) {
    if (params.agentPath === AGENTS_STREAM_PATH) {
      return [JsonataReactorProcessorContract.slug, AGENT_HOST_PROCESSOR_SLUG];
    }
    return [
      AgentChatProcessorContract.slug,
      AgentProcessorContract.slug,
      agentLlmProcessorSlug(await this.resolveLlmProvider(params)),
      AGENT_HOST_PROCESSOR_SLUG,
    ];
  }

  private async getAgentProcessorRunnerState(
    params: AgentDurableObjectStructuredName,
    processorSlug: string,
  ) {
    const runner = this.env.STREAM_PROCESSOR_RUNNER.getByName(
      agentProcessorRunnerName({ ...params, processorSlug }),
    ) as unknown as { runtimeState(): Promise<AgentProcessorRuntimeState> };
    return await runner.runtimeState();
  }

  private async currentStreamMaxOffset(params: AgentDurableObjectStructuredName) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: params.agentPath,
    });
    return (await stream.history({ before: "end" })).at(-1)?.offset ?? 0;
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
        `select p.id, p.slug
         from projects p
         where p.id = ?
         limit 1`,
      )
        .bind(this.structuredName.projectId)
        .first<{ id: string; slug: string }>();
      if (row == null) return null;
      return {
        id: row.id,
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

  private streamsEntrypoint(streamPath: StreamPath) {
    return agentStreamApiFromNamespace({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      streamPath,
    });
  }
}

type AgentProcessorRuntimeState = {
  afterAppendCompletedThroughOffset: number;
  reducedThroughOffset: number;
  state: unknown;
};

export async function ensureChildAgentRunner(args: {
  agentNamespace: DurableObjectNamespace<AgentDurableObject> | undefined;
  event: Event;
  projectId: string;
}) {
  if (args.agentNamespace === undefined) return;
  if (args.event.type !== STREAM_CHILD_STREAM_CREATED_TYPE) return;

  const payload = args.event.payload as { childPath?: unknown };
  const childPath = StreamPath.safeParse(payload.childPath);
  if (!childPath.success) return;

  const name = getAgentDurableObjectName({
    agentPath: childPath.data,
    projectId: args.projectId,
  });
  const stub = args.agentNamespace.getByName(name);
  await stub.initialize({ name });
}

// Ensures the AgentDurableObject for the stream the host processor is running on is initialized.
//
// Agent streams created by routing (e.g. Slack-routed `/agents/slack/<channel>/<ts>` streams) are
// bootstrapped with only the `slack-agent` and `agent-host` subscriptions. Unlike the UI new-agent
// flow, nothing registers the LLM processors (`agent-chat`/`agent`/the provider processor) or seeds
// the agent setup events. Waking the AgentDurableObject here runs its `onInstanceWake` hook, which
// registers those processors and setup events — restoring the behaviour the old runtime got from
// subscribing a callable to `AgentDurableObject.afterAppend` on the routed stream.
export async function ensureAgentRunnerForOwnStream(args: {
  agentNamespace: DurableObjectNamespace<AgentDurableObject> | undefined;
  event: Event;
  projectId: string;
  streamPath: StreamPath;
}) {
  if (args.agentNamespace === undefined) return;
  if (args.event.type !== STREAM_CREATED_TYPE) return;
  // The `/agents` root DO is created explicitly by the project lifecycle; it is not an agent.
  if (args.streamPath === AGENTS_STREAM_PATH) return;

  const name = getAgentDurableObjectName({
    agentPath: args.streamPath,
    projectId: args.projectId,
  });
  const stub = args.agentNamespace.getByName(name);
  await stub.initialize({ name });
}

export async function handleAgentOutputAddedForCodemode(args: {
  codemodeSessionNamespace: DurableObjectNamespace<CodemodeSession> | undefined;
  event: Event;
  projectId: string;
  streamPath: StreamPath;
}) {
  if (args.codemodeSessionNamespace === undefined) return;
  if (args.streamPath === AGENTS_STREAM_PATH) return;
  if (args.event.type !== "events.iterate.com/agent/output-added") return;

  const payload = args.event.payload as { content?: unknown };
  if (typeof payload.content !== "string") return;

  const code = extractCodemodeScript(payload.content);
  if (code == null) return;

  await startCodemodeScriptOnExistingSession({
    code,
    events: [],
    namespace: args.codemodeSessionNamespace,
    projectId: args.projectId,
    streamPath: args.streamPath,
  });
}

export async function handleCodemodeScriptExecutionCompletedForAgent(args: {
  appendInput(input: { event: EventInput }): Promise<unknown>;
  event: Event;
  streamPath: StreamPath;
}) {
  if (args.streamPath === AGENTS_STREAM_PATH) return;
  if (args.event.type !== "events.iterate.com/codemode/script-execution-completed") return;

  const payload = args.event.payload as {
    outcome?: unknown;
    scriptExecutionId?: unknown;
  };
  const outcome = payload.outcome;
  if (outcome == null || typeof outcome !== "object") return;

  const status = "status" in outcome ? outcome.status : undefined;
  if (status === "returned") {
    const value = "value" in outcome ? outcome.value : undefined;
    if (value === undefined) return;
    await args.appendInput({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `agent-codemode-script-result:${String(payload.scriptExecutionId)}`,
        payload: {
          content: codemodeCompletionInputBlock({
            event: args.event,
            outcome: {
              status,
              value,
            },
          }),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    });
    return;
  }

  if (status === "threw") {
    const error = "error" in outcome ? outcome.error : "Unknown codemode error";
    await args.appendInput({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `agent-codemode-script-error:${String(payload.scriptExecutionId)}`,
        payload: {
          content: codemodeCompletionInputBlock({
            event: args.event,
            outcome: {
              error,
              status,
            },
          }),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    });
  }
}

function normalizeIdempotencyKeyPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, "-");
}

function hasEquivalentDefaultSetupEvent(input: {
  event: { type: string };
  existingEvents: readonly { payload: unknown; type: string }[];
}) {
  if (input.event.type === "events.iterate.com/agent/system-prompt-updated") {
    return input.existingEvents.some((event) => event.type === input.event.type);
  }
  return input.existingEvents.some((event) => event.type === input.event.type);
}

export function readOpenAiApiKey(env: Record<string, unknown>) {
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

export function extractCodemodeScript(content: string): string | null {
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

export function codemodeCompletionInputBlock(input: {
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

export function createOpenAiResponsesWebSocketClient(client: OpenAI): OpenAiResponsesWebSocket {
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
