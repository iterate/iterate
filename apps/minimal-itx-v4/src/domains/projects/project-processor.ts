import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "../streams/engine/stream-processor.ts";
import { durableObjectProcessorSubscriber } from "../streams/engine/shared/callable-subscriber.ts";
import type { Env } from "../../env.ts";
import type { Project, StreamEvent } from "../../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { AgentProcessorContract } from "../agents/agent-processor.ts";
import { RepoProcessorContract } from "../repos/repo-processor.ts";
import { CoreProcessorContract } from "../streams/engine/processors/core/contract.ts";
import { ItxContract } from "../../itx/processor-contract.ts";

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.1.0",
  description:
    "Tiny project projection: bootstrap the fake repo and subscribe child domain processors.",
  stateSchema: z.object({
    agents: z.array(z.string()).default([]),
    created: z.boolean().default(false),
    repos: z.array(z.string()).default([]),
  }),
  initialState: { agents: [], created: false, repos: [] },
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
  },
  consumes: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/stream/child-stream-created",
  ],
  processorDeps: [CoreProcessorContract],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/stream/subscription-configured",
  ],
});
type ProjectProcessorDeps = {
  env: Env;
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
    runInBackground,
    event,
    append,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/stream/subscription-configured",
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
        });
        runInBackground(async () => {
          setTimeout(async () => {
            // TODO type is wrong! should be async for sure
            await append({
              type: "events.iterate.com/project/created",
              payload: event.payload,
            });
          }, 100);
        });
        break;
      }
      case "events.iterate.com/project/created": {
        // Touching the child stream wakes the real Stream Durable Object. Its
        // core processor emits events.iterate.com/stream/child-stream-created
        // back onto this root stream; this processor reacts to that announcement
        // below and wires the repo processor to the child stream.
        blockProcessorWhile(async () => {
          await this.deps.env.STREAM.getByName(
            DurableObjectNameCodec.stringify({
              projectId: this.deps.projectId,
              path: "/repos/project",
            }),
          ).runtimeState();
        });
        return;
      }

      case "events.iterate.com/stream/child-stream-created": {
        const path = event.payload.childPath;
        if (path.startsWith("/repos/")) {
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/stream/subscription-configured",
              payload: {
                subscriptionKey: RepoProcessorContract.slug,
                subscriber: durableObjectProcessorSubscriber({
                  bindingName: "REPO",
                  durableObjectName: DurableObjectNameCodec.stringify({
                    projectId: this.deps.projectId,
                    path,
                  }),
                  processorName: RepoProcessorContract.slug,
                }),
              },
            });
          });
          return;
        }

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
