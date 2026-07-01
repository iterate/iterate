import { StreamProcessor } from "../streams/stream-processor.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { PROJECT_REPO_PATH } from "../repos/utils.ts";
import type { StreamEvent, StreamListItem } from "../../types.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_SYSTEM_PROMPT,
} from "../agents/agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "../agents/cloudflare-ai-processor-contract.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

const PROJECT_WORKER_READY_ATTEMPTS = 20;
const PROJECT_WORKER_READY_RETRY_MS = 100;
const PROJECT_WORKER_READY_URL = "https://minimal-itx-v4.localhost/__itx_project_ready";

export class ProjectProcessor extends StreamProcessor<
  typeof ProjectProcessorContract,
  {
    itx: ProjectRpcTarget;
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
            await this.deps.itx.streams.get(childPath).append(
              buildDurableObjectProcessorSubscriptionConfiguredEvent({
                durableObjectName,
                processorSlug: AgentProcessorContract.slug,
                subscriberType: "agent",
              }),
              buildDurableObjectProcessorSubscriptionConfiguredEvent({
                durableObjectName,
                processorSlug: CloudflareAiProcessorContract.slug,
                subscriberType: "agent",
              }),
              buildDurableObjectProcessorSubscriptionConfiguredEvent({
                durableObjectName,
                processorSlug: ItxProcessorContract.slug,
                subscriberType: "itx",
              }),
              {
                type: "events.iterate.com/agent/config-updated",
                idempotencyKey: `agent/config-updated:${this.deps.itx.projectId}:${childPath}`,
                payload: { systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT },
              },
              {
                type: "events.iterate.com/agent/llm-provider-selected",
                idempotencyKey: `agent/llm-provider-selected:${this.deps.itx.projectId}:${childPath}`,
                payload: {
                  ifUnset: true,
                  model: DEFAULT_AGENT_MODEL,
                  provider: "cloudflare-ai",
                },
              },
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
        });
        return;
      }

      default:
        return;
    }
  }
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

async function waitForDefaultProjectWorker(itx: ProjectRpcTarget): Promise<void> {
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
