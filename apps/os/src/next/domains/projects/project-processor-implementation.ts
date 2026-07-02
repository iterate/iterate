import { StreamProcessor } from "../streams/stream-processor.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { PROJECT_REPO_PATH } from "../repos/utils.ts";
import { PROJECT_REPO_ONBOARDING_MD } from "../repos/project-repo-template.ts";
import type { StreamEvent, StreamListItem } from "../../types.ts";
import type { ItxRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  type AgentLlmProvider,
} from "../agents/agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "../agents/cloudflare-ai-processor-contract.ts";
import {
  DEFAULT_OPENAI_WS_MODEL,
  OpenAiWsProcessorContract,
} from "../agents/openai-ws-processor-contract.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { SlackAgentProcessorContract } from "../integrations/slack-agent-processor-contract.ts";
import { SlackProcessorContract } from "../integrations/slack-processor-contract.ts";
import { isSlackAgentPath, SLACK_INTEGRATION_STREAM_PATH } from "../integrations/utils.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

export const ONBOARDING_AGENT_PATH = "/agents/onboarding";

/**
 * Agents under `/agents/slack/**` are Slack-thread agents: the slack webhook
 * router forwards raw thread webhooks to their stream, the `slack-agent`
 * processor transcribes them, and replies go out through the itx.slack Web
 * API capability instead of web chat.
 */
export const SLACK_AGENT_SYSTEM_PROMPT = [
  "You are an iterate AI agent running inside a Slack thread.",
  "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
  "The code block must contain a single async arrow function: async (itx) => { ... }.",
  "Incoming Slack webhook events arrive as your inputs. Reply only when mentioned, directly asked, or clearly needed.",
  "To reply in the thread, use await itx.slack.chat.postMessage({ channel, thread_ts, text }) with the channel and thread_ts from the incoming webhook payloads. Never use itx.chat.sendMessage for Slack replies. Do not return side-effect-only call results unless you need to inspect them on your next turn.",
  "Use project capabilities on itx when they are relevant.",
].join("\n");

/**
 * The onboarding agent is a normal web-chat agent whose system prompt embeds
 * the seeded ONBOARDING.md script. Same codemode contract as every agent.
 */
export const ONBOARDING_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "You are this project's onboarding agent. Follow the onboarding script below.",
  "",
  PROJECT_REPO_ONBOARDING_MD,
].join("\n");

const PROJECT_WORKER_READY_ATTEMPTS = 20;
const PROJECT_WORKER_READY_RETRY_MS = 100;
const PROJECT_WORKER_READY_URL = "https://minimal-itx-v4.localhost/__itx_project_ready";

export class ProjectProcessor extends StreamProcessor<
  typeof ProjectProcessorContract,
  {
    /** Provider new agents are born with ("openai-ws" when the deployment has an OpenAI key). */
    defaultLlmProvider: AgentLlmProvider;
    itx: ItxRpcTarget;
  }
> {
  readonly contract = ProjectProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return { ...state, createRequest: event.payload };
      case "events.iterate.com/project/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return { ...state, created: true };
      case "events.iterate.com/stream/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return recordStream(state, event.payload.path, event.createdAt);
      case "events.iterate.com/stream/child-stream-created":
        return recordStream(state, event.payload.childPath, event.createdAt);
      default:
        return state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
    append,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["processEvent"]>[0]): undefined {
    if (previousState.created) {
      runInBackground(async () => {
        try {
          await this.deps.itx.worker.processEvent({ event: event as StreamEvent });
        } catch (error) {
          console.log("project worker processEvent failed", error);
        }
      });
    }

    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.itx.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.itx.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          await append(
            buildDurableObjectProcessorSubscriptionConfiguredEvent({
              durableObjectName: DurableObjectNameCodec.stringify({
                projectId: this.deps.itx.projectId,
                path: "/",
              }),
              processorSlug: ItxProcessorContract.slug,
              subscriberType: "itx",
            }),
          );
          // Arm the Slack webhook router on `/integrations/slack` from birth,
          // so a claimed workspace's first webhook routes even if the connect
          // flow's own belt-and-braces subscription append raced.
          await this.deps.itx.streams.get(SLACK_INTEGRATION_STREAM_PATH).append(
            buildDurableObjectProcessorSubscriptionConfiguredEvent({
              durableObjectName: DurableObjectNameCodec.stringify({
                projectId: this.deps.itx.projectId,
                path: SLACK_INTEGRATION_STREAM_PATH,
              }),
              idempotencyKey: `slack-router-subscription:${this.deps.itx.projectId}`,
              processorSlug: SlackProcessorContract.slug,
              subscriberType: "project",
            }),
          );
          await append({
            type: "events.iterate.com/repo/create-requested",
            idempotencyKey: `repo-create-requested:${this.deps.itx.projectId}:${PROJECT_REPO_PATH}`,
            payload: {
              path: PROJECT_REPO_PATH,
              projectId: this.deps.itx.projectId,
            },
          });
        });
        break;
      }
      case "events.iterate.com/stream/child-stream-created": {
        const childPath = event.payload.childPath;
        if (!childPath.startsWith("/agents/") && !childPath.startsWith("/secrets/")) return;
        blockProcessorWhile(async () => {
          const durableObjectName = DurableObjectNameCodec.stringify({
            projectId: this.deps.itx.projectId,
            path: childPath,
          });
          if (childPath.startsWith("/agents/")) {
            // Agents under /agents/slack/** additionally get the slack-agent
            // processor subscription and the Slack reply prompt — this is THE
            // place the "slack thread streams are slack agents" rule lives.
            const isSlack = isSlackAgentPath(childPath);
            await this.deps.itx.streams.get(childPath).append(
              // Identical idempotency keys to the create-time onboarding birth
              // certificate, so whichever lane runs second dedupes cleanly.
              ...agentBirthCertificateEvents({
                childPath,
                llmProvider: this.deps.defaultLlmProvider,
                projectId: this.deps.itx.projectId,
                slack: isSlack,
                systemPrompt: isSlack ? SLACK_AGENT_SYSTEM_PROMPT : DEFAULT_AGENT_SYSTEM_PROMPT,
              }),
            );
            return;
          }

          await this.deps.itx.streams.get(childPath).append(
            buildDurableObjectProcessorSubscriptionConfiguredEvent({
              durableObjectName,
              processorSlug: SecretProcessorContract.slug,
              subscriberType: "secret",
            }),
          );
        });
        return;
      }
      case "events.iterate.com/repo/created": {
        if (
          event.payload.projectId !== this.deps.itx.projectId ||
          event.payload.path !== PROJECT_REPO_PATH ||
          state.created ||
          state.createRequest === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          await waitForDefaultProjectWorker(this.deps.itx);
          await append({
            type: "events.iterate.com/project/created",
            idempotencyKey: `project-created:${this.deps.itx.projectId}`,
            payload: state.createRequest!,
          });
          // Seed the onboarding agent: full birth certificate (the generic
          // child-stream-created lane later double-appends with the same
          // idempotency keys and dedupes) plus the kickoff input that makes the
          // agent greet the user without waiting for a first message.
          await this.deps.itx.streams.get(ONBOARDING_AGENT_PATH).append(
            ...agentBirthCertificateEvents({
              childPath: ONBOARDING_AGENT_PATH,
              llmProvider: this.deps.defaultLlmProvider,
              projectId: this.deps.itx.projectId,
              systemPrompt: ONBOARDING_AGENT_SYSTEM_PROMPT,
            }),
            {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: `project-onboarding-start:${this.deps.itx.projectId}`,
              payload: {
                content:
                  "Start onboarding now. The project owner just created this project and is looking at the chat.",
                llmRequestPolicy: { behaviour: "after-current-request" as const },
              },
            },
          );
        });
        return;
      }

      default:
        return;
    }
  }
}

const DEFAULT_MODEL_BY_LLM_PROVIDER = {
  "cloudflare-ai": DEFAULT_AGENT_MODEL,
  "openai-ws": DEFAULT_OPENAI_WS_MODEL,
} satisfies Record<AgentLlmProvider, string>;

function agentBirthCertificateEvents(input: {
  childPath: string;
  llmProvider: AgentLlmProvider;
  projectId: string;
  slack?: boolean;
  systemPrompt: string;
}) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    projectId: input.projectId,
    path: input.childPath,
  });
  const subscription = (processorSlug: string, subscriberType: "agent" | "itx") =>
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${processorSlug}`,
      processorSlug,
      subscriberType,
    });
  return [
    subscription(AgentProcessorContract.slug, "agent"),
    // Both provider processors subscribe; only the one matching the agent's
    // selected llmProvider answers llm-request-requested events.
    subscription(CloudflareAiProcessorContract.slug, "agent"),
    subscription(OpenAiWsProcessorContract.slug, "agent"),
    subscription(ItxProcessorContract.slug, "itx"),
    ...(input.slack ? [subscription(SlackAgentProcessorContract.slug, "agent")] : []),
    {
      type: "events.iterate.com/agent/config-updated" as const,
      idempotencyKey: `agent/config-updated:${input.projectId}:${input.childPath}`,
      payload: { systemPrompt: input.systemPrompt },
    },
    {
      type: "events.iterate.com/agent/llm-provider-selected" as const,
      idempotencyKey: `agent/llm-provider-selected:${input.projectId}:${input.childPath}`,
      payload: {
        ifUnset: true,
        model: DEFAULT_MODEL_BY_LLM_PROVIDER[input.llmProvider],
        provider: input.llmProvider,
      },
    },
  ];
}

function recordStream<
  State extends {
    agents: StreamListItem[];
    repos: StreamListItem[];
    secrets: StreamListItem[];
    streams: StreamListItem[];
  },
>(state: State, path: string, createdAt: string): State {
  const item = { path, createdAt };
  return {
    ...state,
    agents: path.startsWith("/agents/") ? addStreamListItem(state.agents, item) : state.agents,
    repos:
      path === PROJECT_REPO_PATH || path.startsWith("/repos/")
        ? addStreamListItem(state.repos, item)
        : state.repos,
    secrets: path.startsWith("/secrets/") ? addStreamListItem(state.secrets, item) : state.secrets,
    streams: addStreamListItem(state.streams, item),
  };
}

function addStreamListItem(items: StreamListItem[], item: StreamListItem): StreamListItem[] {
  if (items.some((existing) => existing.path === item.path)) return items;
  return [...items, item].sort((a, b) => a.path.localeCompare(b.path));
}

async function waitForDefaultProjectWorker(itx: ItxRpcTarget): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_WORKER_READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await itx.worker.fetch(new Request(PROJECT_WORKER_READY_URL));
      // This probe only cares that the project worker accepted the request. The
      // returned Response can be a Cap'n Web RPC stub, and keeping that stub
      // alive after the probe succeeds is exactly the lifecycle pattern these
      // stream tests are trying to avoid: a short-lived readiness check should
      // not retain a remote object until the whole project bootstrap session
      // ends. Dispose when the runtime supplies Symbol.dispose; local/miniflare
      // Response objects without that hook are a no-op here.
      disposeRpcResult(response);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === PROJECT_WORKER_READY_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, PROJECT_WORKER_READY_RETRY_MS));
    }
  }
  throw new Error("Default project worker did not become ready before project/created.", {
    cause: lastError,
  });
}

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}
