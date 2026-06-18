import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import type { Env } from "../../env.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { formatDurableObjectName } from "../durable-object-names.ts";
import { AgentProcessorContract } from "../agents/agent-processor.ts";
import { RepoProcessorContract } from "../repos/repo-processor.ts";

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
    "events.iterate.com/project/created": {
      description: "The project root was created.",
      payloadSchema: z.looseObject({ projectId: z.string() }),
    },
    "events.iterate.com/stream/child-stream-created": {
      description: "A child stream was announced by the real Stream processor.",
      payloadSchema: z.looseObject({ childPath: z.string() }),
    },
    "events.iterate.com/stream/subscription-configured": {
      description: "Configures delivery from a stream to a hosted processor.",
      payloadSchema: z.looseObject({}),
    },
  },
  consumes: [
    "events.iterate.com/project/created",
    "events.iterate.com/stream/child-stream-created",
  ],
  emits: ["events.iterate.com/stream/subscription-configured"],
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
    event,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/project/created": {
        if (event.payload.projectId !== this.deps.projectId) return;

        // Touching the child stream wakes the real Stream Durable Object. Its
        // core processor emits events.iterate.com/stream/child-stream-created
        // back onto this root stream; this processor reacts to that announcement
        // below and wires the repo processor to the child stream.
        blockProcessorWhile(async () => {
          await this.deps.env.STREAM.getByName(
            formatDurableObjectName({ projectId: this.deps.projectId, path: "/repos/project" }),
          ).runtimeState();
        });
        return;
      }

      case "events.iterate.com/stream/child-stream-created": {
        const path = event.payload.childPath;
        if (path.startsWith("/repos/")) {
          blockProcessorWhile(async () => {
            await this.deps.env.STREAM.getByName(
              formatDurableObjectName({ projectId: this.deps.projectId, path }),
            ).append({
              event: {
                type: "events.iterate.com/stream/subscription-configured",
                payload: {
                  subscriptionKey: `repo:${this.deps.projectId}:${path}`,
                  subscriber: durableObjectProcessorSubscriber({
                    bindingName: "REPO",
                    durableObjectName: formatDurableObjectName({
                      projectId: this.deps.projectId,
                      path,
                    }),
                    processorName: RepoProcessorContract.slug,
                  }),
                },
              },
            });
          });
          return;
        }

        if (path.startsWith("/agents/")) {
          const durableObjectName = formatDurableObjectName({
            projectId: this.deps.projectId,
            path,
          });
          blockProcessorWhile(async () => {
            await this.deps.env.STREAM.getByName(durableObjectName).appendBatch({
              events: [
                {
                  type: "events.iterate.com/stream/subscription-configured",
                  payload: {
                    subscriptionKey: `agent:${this.deps.projectId}:${path}`,
                    subscriber: durableObjectProcessorSubscriber({
                      bindingName: "AGENT",
                      durableObjectName,
                      processorName: AgentProcessorContract.slug,
                    }),
                  },
                },
                {
                  type: "events.iterate.com/stream/subscription-configured",
                  payload: {
                    subscriptionKey: `itx:${this.deps.projectId}:${path}`,
                    subscriber: durableObjectProcessorSubscriber({
                      bindingName: "AGENT",
                      durableObjectName,
                      processorName: ItxContract.slug,
                    }),
                  },
                },
              ],
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
