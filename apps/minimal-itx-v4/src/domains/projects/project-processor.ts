import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "../streams/engine/stream-processor.ts";
import { durableObjectProcessorSubscriber } from "../streams/engine/shared/callable-subscriber.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { AgentProcessorContract } from "../agents/agent-processor.ts";
import { PROJECT_REPO_PATH } from "../repos/project-repo.ts";
import { CoreProcessorContract } from "../streams/engine/processors/core/contract.ts";
import type { StreamEvent } from "../streams/engine/shared/event.ts";
import { ItxContract } from "../../itx/processor-contract.ts";

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.1.0",
  description:
    "Tiny project projection: bootstrap the fake repo and subscribe child domain processors.",
  stateSchema: z.object({
    agents: z.array(z.string()).default([]),
    createRequest: z
      .object({
        projectId: z.string(),
        slug: z.string(),
      })
      .nullable()
      .default(null),
    created: z.boolean().default(false),
    repos: z.array(z.string()).default([]),
  }),
  initialState: { agents: [], createRequest: null, created: false, repos: [] },
  events: {
    "events.iterate.com/project/create-requested": {
      description: "A project creation was requested.",
      payloadSchema: z.object({
        projectId: z.string(),
        slug: z.string(),
      }),
    },
    "events.iterate.com/project/created": {
      description: "The project root was created.",
      payloadSchema: z.object({
        projectId: z.string(),
        slug: z.string(),
      }),
    },
    "events.iterate.com/repo/create-requested": {
      description: "The project root repo should be created.",
      payloadSchema: z.object({
        projectId: z.string(),
        path: z.string(),
      }),
    },
    "events.iterate.com/repo/created": {
      description: "A project repo was created.",
      payloadSchema: z.object({
        artifactName: z.string(),
        defaultBranch: z.string(),
        path: z.string(),
        projectId: z.string(),
        remote: z.string(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/child-stream-created",
  ],
  processorDeps: [CoreProcessorContract],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});
type ProjectProcessorDeps = {
  ensureDefaultWorkerLoaded(): Promise<void>;
  forwardEventToProjectWorker(event: StreamEvent): Promise<void>;
  projectId: string;
};

export class ProjectProcessor extends StreamProcessor<
  typeof ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        if (event.payload.projectId !== this.deps.projectId) return state;
        return { ...state, createRequest: event.payload };
      case "events.iterate.com/project/created":
        if (event.payload.projectId !== this.deps.projectId) return state;
        return { ...state, created: true };
      case "events.iterate.com/stream/child-stream-created": {
        const path = event.payload.childPath;
        if (path.startsWith("/repos/") && !state.repos.includes(path)) {
          return { ...state, repos: [...state.repos, path] };
        }
        if (path.startsWith("/agents/") && !state.agents.includes(path)) {
          return { ...state, agents: [...state.agents, path] };
        }
        return state;
      }
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
          await this.deps.forwardEventToProjectWorker(event as StreamEvent);
        } catch (error) {
          console.log("project worker processEvent failed", error);
        }
      });
    }

    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          append({
            type: "events.iterate.com/stream/subscription-configured",
            idempotencyKey: `stream-subscription:${this.deps.projectId}:${ItxContract.slug}`,
            payload: {
              subscriptionKey: ItxContract.slug,
              subscriber: durableObjectProcessorSubscriber({
                bindingName: "PROJECT",
                durableObjectName: DurableObjectNameCodec.stringify({
                  projectId: this.deps.projectId,
                  path: "/",
                }),
                processorName: ItxContract.slug,
              }),
            },
          });
          append({
            type: "events.iterate.com/repo/create-requested",
            idempotencyKey: `repo-create-requested:${this.deps.projectId}:${PROJECT_REPO_PATH}`,
            payload: {
              path: PROJECT_REPO_PATH,
              projectId: this.deps.projectId,
            },
          });
        });
        break;
      }
      case "events.iterate.com/repo/created": {
        if (
          event.payload.projectId !== this.deps.projectId ||
          event.payload.path !== PROJECT_REPO_PATH ||
          state.created ||
          state.createRequest === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          await this.deps.ensureDefaultWorkerLoaded();
          append({
            type: "events.iterate.com/project/created",
            idempotencyKey: `project-created:${this.deps.projectId}`,
            payload: state.createRequest!,
          });
        });
        return;
      }

      case "events.iterate.com/stream/child-stream-created": {
        const path = event.payload.childPath;
        if (path.startsWith("/agents/")) {
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/stream/subscription-configured",
              payload: {
                subscriptionKey: AgentProcessorContract.slug,
                subscriber: durableObjectProcessorSubscriber({
                  bindingName: "AGENT",
                  durableObjectName: DurableObjectNameCodec.stringify({
                    projectId: this.deps.projectId,
                    path,
                  }),
                  processorName: AgentProcessorContract.slug,
                }),
              },
            });
          });
          return;
        }
        return;
      }
      default:
        return;
    }
  }
}
