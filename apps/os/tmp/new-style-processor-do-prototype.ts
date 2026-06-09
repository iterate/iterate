// @ts-nocheck
//
// Prototype only. This file sketches how new-style StreamProcessor instances
// connect to the Stream Durable Object from OS Durable Objects and dynamic
// project workers.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Stream } from "@iterate-com/streams/workers/durable-objects/stream";
import { StreamProcessor } from "@iterate-com/streams/stream-processor-v2";

/**
 * Subscriber descriptors as event payloads.
 *
 * These are temporarily accepted in packages/streams. Longer term, packages/streams
 * should probably accept a generic subscriber descriptor and OS should own these
 * variants.
 */
type OsSubscriber =
  | {
      type: "built-in";
      transport: "workers-rpc";
      processorSlug: string;
    }
  | {
      type: "durable-object-processor";
      durableObject: "project" | "agent";
      processor: "projectProcessor" | "agentProcessor";
    }
  | {
      type: "project-worker-entrypoint";
      entrypoint: "default" | string;
    };

/**
 * OS Stream subclass.
 *
 * The shared Stream runtime keeps the subscription event/reconciliation machinery.
 * OS decides what subscriber descriptors mean by overriding getSubscriptionTarget.
 */
export class OsStream extends Stream {
  protected getSubscriptionTarget(args) {
    const subscriber = args.configured.latestConfiguredEvent.payload.subscriber as OsSubscriber;
    const [projectId, streamPath] = args.streamName.split(":");

    switch (subscriber.type) {
      case "built-in":
        return this.env.STREAM_PROCESSOR_RUNNER.getByName(
          `${args.streamName}:${args.subscriptionKey}`,
        );

      case "durable-object-processor":
        if (subscriber.durableObject === "project") {
          return this.env.PROJECT.getByName(projectId);
        }
        if (subscriber.durableObject === "agent") {
          return this.env.AGENT.getByName(agentNameFromStreamPath({ projectId, streamPath }));
        }
        throw new Error(`Unsupported durable-object processor target ${subscriber.durableObject}`);

      case "project-worker-entrypoint":
        return this.env.PROJECT_WORKER_PROCESSOR_RUNNER.getByName(
          `${args.streamName}:${args.subscriptionKey}`,
        );
    }
  }
}

/**
 * Project Durable Object with embedded processors.
 *
 * This is the shape we are aiming for:
 * - processors are public RpcTarget-like members
 * - requestSubscription is the bridge from Stream outbound delivery to one
 *   embedded processor
 * - batches are serialized by the StreamProcessor instance
 */
export class ProjectDurableObject extends DurableObject {
  #subscriptions = new Map<string, { unsubscribe(): void }>();

  readonly projectProcessor = new ProjectProcessor({
    sql: this.ctx.storage.sql,
    deps: {
      env: this.env,
      iterateContext: this.#iterateContextForStream({ path: "/" }),
      keepAliveWhile: (work) => this.#keepAliveWhile(work),
    },
  });

  readonly agentProcessor = new AgentProcessor({
    sql: this.ctx.storage.sql,
    deps: {
      env: this.env,
      iterateContext: this.#iterateContextForStream({ path: "/agents" }),
      keepAliveWhile: (work) => this.#keepAliveWhile(work),
    },
  });

  get state() {
    return {
      agentProcessor: this.agentProcessor.state,
      projectProcessor: this.projectProcessor.state,
    };
  }

  async requestSubscription(args) {
    const subscriber = args.subscriptionConfiguredEvent.payload.subscriber as OsSubscriber;
    if (subscriber.type !== "durable-object-processor" || subscriber.durableObject !== "project") {
      throw new Error("ProjectDurableObject only accepts project durable-object processors.");
    }

    const processor = this.#processorByName(subscriber.processor);
    const previous = this.#subscriptions.get(args.subscriptionKey);
    previous?.unsubscribe();

    const handle = await args.stream.subscribeOutbound({
      subscriptionKey: args.subscriptionKey,
      replayAfterOffset: processor.checkpointOffset,
      processEventBatch: (batch) => {
        const processing = processor.processEventBatch(batch);
        this.ctx.waitUntil(processing);
      },
    });
    this.#subscriptions.set(args.subscriptionKey, handle);
  }

  #processorByName(name: string) {
    if (name === "projectProcessor") return this.projectProcessor;
    if (name === "agentProcessor") return this.agentProcessor;
    throw new Error(`Unknown project processor ${name}`);
  }

  #iterateContextForStream(args: { path: string }) {
    // Real code should construct a project-scoped IterateContext whose
    // ctx.project.streams capability defaults to args.path.
    return {
      project: {
        streams: this.ctx.exports.StreamsCapability({
          props: {
            projectId: this.ctx.id.name,
            streamPath: args.path,
          },
        }),
      },
    };
  }

  #keepAliveWhile(work) {
    // Prototype behavior. Later this becomes alarm-backed keepalive.
    this.ctx.waitUntil(
      work().catch((error) => {
        console.error("processor keepAliveWhile failed", error);
        throw error;
      }),
    );
  }
}

class ProjectProcessor extends StreamProcessor {
  constructor(args) {
    super({
      contract: ProjectProcessorContract,
      deps: args.deps,
      sql: args.sql,
    });
  }

  async create(args) {
    await this.ctx.project.streams.append({
      event: {
        type: "events.iterate.com/project/create-requested",
        idempotencyKey: `project-create-requested:${args.projectId}`,
        payload: args,
      },
    });
  }

  protected processEvent({ event, blockProcessorWhile, runInBackground }) {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        blockProcessorWhile(async () => {
          await this.ctx.project.streams.append({
            event: {
              type: "events.iterate.com/project/created",
              idempotencyKey: `project-created:${event.offset}`,
              payload: event.payload,
            },
          });
        });
        break;

      case "events.iterate.com/stream/child-stream-created":
        if (event.payload.childPath.startsWith("/agents/")) {
          runInBackground(async () => {
            await this.ctx.project.streams.append({
              path: event.payload.childPath,
              event: {
                type: "events.iterate.com/stream/subscription-configured",
                idempotencyKey: `agent-processor-subscription:${event.payload.childPath}`,
                payload: {
                  subscriptionKey: "agent-processor",
                  subscriber: {
                    type: "durable-object-processor",
                    durableObject: "agent",
                    processor: "agentProcessor",
                  },
                },
              },
            });
          });
        }
        break;
    }
  }
}

class AgentProcessor extends StreamProcessor {
  constructor(args) {
    super({
      contract: AgentProcessorContract,
      deps: args.deps,
      sql: args.sql,
    });
  }

  async sendMessage(args) {
    await this.ctx.project.streams.append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `agent-input:${crypto.randomUUID()}`,
        payload: args,
      },
    });
  }

  protected processEvent({ event, blockProcessorWhile, runInBackground }) {
    switch (event.type) {
      case "events.iterate.com/agent/input-added":
        blockProcessorWhile(async () => {
          const response = await this.deps.env.AI.run("@cf/meta/llama", {
            prompt: event.payload.text,
          });

          await this.ctx.project.streams.append({
            event: {
              type: "events.iterate.com/agent/output-added",
              idempotencyKey: `agent-output:${event.offset}`,
              payload: { response },
            },
          });
        });
        break;

      case "events.iterate.com/agent/tool-call-requested":
        runInBackground(async () => {
          await this.ctx.project.streams.append({
            event: {
              type: "events.iterate.com/agent/tool-call-started",
              idempotencyKey: `agent-tool-call-started:${event.offset}`,
              payload: event.payload,
            },
          });
        });
        break;
    }
  }
}

/**
 * Stateless project worker processor runner.
 *
 * The stream sees only a subscription target with requestSubscription. This runner
 * owns loading the project worker entrypoint and subscribing it to stream batches.
 */
export class ProjectWorkerProcessorRunner extends DurableObject {
  #subscription;

  async requestSubscription(args) {
    const subscriber = args.subscriptionConfiguredEvent.payload.subscriber as OsSubscriber;
    if (subscriber.type !== "project-worker-entrypoint") {
      throw new Error("ProjectWorkerProcessorRunner only accepts project-worker-entrypoint.");
    }

    this.#subscription?.unsubscribe();
    const entrypoint = await this.#loadEntrypoint({
      entrypoint: subscriber.entrypoint,
      projectId: args.streamRuntimeState.coreProcessorState.namespace,
      streamPath: args.streamRuntimeState.coreProcessorState.path,
    });

    this.#subscription = await args.stream.subscribeOutbound({
      subscriptionKey: args.subscriptionKey,
      // Stateless first slice: live-only. Add host-owned cursor later if needed.
      replayAfterOffset: args.streamMaxOffset,
      processEventBatch: (batch) => {
        this.ctx.waitUntil(
          entrypoint.processEventBatch({
            ctx: this.#iterateContextForStream({ path: batch.path }),
            events: batch.events,
            streamMaxOffset: batch.streamMaxOffset,
          }),
        );
      },
    });
  }

  async #loadEntrypoint(args) {
    const worker = await this.#loadProjectWorker(args.projectId);
    return args.entrypoint === "default"
      ? worker.getEntrypoint()
      : worker.getEntrypoint(args.entrypoint);
  }

  async #loadProjectWorker(_projectId) {
    throw new Error("same loader path as ProjectDurableObject.loadProjectDynamicWorkerEntrypoint");
  }

  #iterateContextForStream(args) {
    return {
      project: {
        streams: this.ctx.exports.StreamsCapability({
          props: { streamPath: args.path },
        }),
      },
    };
  }
}

/**
 * Project config worker authoring shape for stateless processors.
 */
export const projectConfigWorkerExample = `
import { WorkerEntrypoint } from "cloudflare:workers";

export default {
  async processEventBatch({ events, ctx }) {
    for (const event of events) {
      if (event.type !== "events.iterate.com/stream/child-stream-created") continue;
      if (!event.payload.childPath.startsWith("/repos/")) continue;

      await ctx.project.streams.append({
        path: event.payload.childPath,
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: \`subscribe-repo-worker:\${event.payload.childPath}\`,
          payload: {
            subscriptionKey: "repo-worker",
            subscriber: {
              type: "project-worker-entrypoint",
              entrypoint: "RepoWorker",
            },
          },
        },
      });
    }
  },
};

export class RepoWorker extends WorkerEntrypoint {
  async processEventBatch({ events, ctx }) {
    for (const event of events) {
      if (event.type !== "events.iterate.com/repo/created") continue;

      await ctx.project.streams.append({
        path: "/activity",
        event: {
          type: "events.iterate.com/activity/item-added",
          idempotencyKey: \`repo-activity:\${event.offset}\`,
          payload: { repoId: event.payload.repoId },
        },
      });
    }
  }
}
`;

function agentNameFromStreamPath(args) {
  return `${args.projectId}:${args.streamPath}`;
}

declare const ProjectProcessorContract: unknown;
declare const AgentProcessorContract: unknown;
