import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import type { StreamEvent } from "@iterate-com/os/src/domains/streams/engine/shared/event.ts";
import type { Env } from "../../env.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor, replayPath } from "../../itx/processor.ts";
import { objectToPathInvoker, pathInvokerToProxy } from "../../itx/path-invoker.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { formatDurableObjectName, parseDurableObjectName } from "../durable-object-names.ts";
import { AgentsRpcTarget } from "../agents/agents-rpc-target.ts";
import { StreamsRpcTarget } from "../streams/streams-rpc-target.ts";
import { ProjectProcessor, ProjectProcessorContract } from "./project-processor.ts";

const PROJECT_REPO_PATH = "/repos/project";
type StreamStub = ReturnType<Env["STREAM"]["getByName"]>;
type StreamAppendArgs = Parameters<StreamStub["append"]>[0];
type StreamAppendBatchArgs = Parameters<StreamStub["appendBatch"]>[0];
type HostStream = {
  append(args: StreamAppendArgs): StreamEvent | Promise<StreamEvent>;
  appendBatch(args: StreamAppendBatchArgs): StreamEvent[] | Promise<StreamEvent[]>;
};

export class ProjectDurableObject extends DurableObject<Env> {
  // [[ This line should barf if there is no project id - perhaps we should have parseDurableObjectName take an arg to say whether __null__ is allowed ]]
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);

  dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: this.name,
      }),
    },
    facets: this.ctx.facets,
    loader: this.env.LOADER,
    projectId: this.requireProjectId(),
    storage: this.ctx.storage,
  });

  projectProcessor = this.host.add(
    ProjectProcessorContract.slug,
    (deps) =>
      new ProjectProcessor({
        ...deps,
        env: this.env,
        projectId: this.requireProjectId(),
      }),
  );

  itxProcessor = this.host.add(
    ItxContract.slug,
    (deps) =>
      new ItxProcessor({
        ...deps,
        dynamicWorkers: this.dynamicWorkers,
        iterateContext: { stream: this.#stream() },
        builtinCapabilities: [
          {
            path: [],
            // [[ Is this really needed? The stopAt? ]]
            capability: objectToPathInvoker(this, DurableObject.prototype),
            instructions: "the Project Durable Object's public capability surface",
          },
          {
            path: ["workers"],
            capability: this.dynamicWorkers,
            instructions: "load a project-scoped dynamic worker or Durable Object facet",
          },
        ],
      }),
  );

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  // [[ wtf is this doing here?! ]]
  async createProject(input: { projectId: string }) {
    if (this.name.projectId !== input.projectId || this.name.path !== "/") {
      throw new Error(
        `createProject(${input.projectId}) must run on "${input.projectId}:/", got ${this.ctx.id.name}`,
      );
    }
    const durableObjectName = formatDurableObjectName({
      projectId: this.name.projectId,
      path: this.name.path,
    });
    const stream = this.env.STREAM.getByName(durableObjectName);

    // This is the one external bootstrap: before ProjectProcessor can react to
    // project/created, the stream must know to deliver this root stream to this
    // Project Durable Object. ITX is subscribed at the same coordinate because
    // the project context is also the project root stream.
    await stream.appendBatch({
      events: [
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `project-subscription:${input.projectId}:project`,
          payload: {
            subscriptionKey: `project:${input.projectId}`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "PROJECT",
              durableObjectName,
              processorName: ProjectProcessorContract.slug,
            }),
          },
        },
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `project-subscription:${input.projectId}:itx`,
          payload: {
            subscriptionKey: `itx:${input.projectId}:/`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "PROJECT",
              durableObjectName,
              processorName: ItxContract.slug,
            }),
          },
        },
        {
          type: "events.iterate.com/project/created",
          idempotencyKey: `project-created:${input.projectId}`,
          payload: { projectId: input.projectId },
        },
      ],
    });

    return { id: input.projectId };
  }

  invokeCapability(args: { path: string[]; args?: unknown[] }) {
    return this.itxProcessor.invokeCapability(args);
  }

  async egress(
    url: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: string; viaProject: string }> {
    const response = await globalThis.fetch(url, init);
    return {
      status: response.status,
      body: await response.text(),
      viaProject: this.requireProjectId(),
    };
  }

  get repo() {
    const repo = this.env.REPO.getByName(
      formatDurableObjectName({
        path: PROJECT_REPO_PATH,
        projectId: this.requireProjectId(),
      }),
    );
    // The project repo is a mounted domain object, not an adapter with a
    // hand-picked method list. Return a Cap'n Web-visible path proxy so
    // `project.repo.anyPublicMethod(...)` replays onto the real Repo Durable
    // Object stub and future Repo methods do not need to be mirrored here.
    return pathInvokerToProxy({
      invokeCapability: ({ path, args = [] }) => replayPath({ args, path, target: repo }),
    });
  }

  get agents() {
    return new AgentsRpcTarget({ projectId: this.requireProjectId() });
  }

  get streams() {
    return new StreamsRpcTarget({ projectId: this.requireProjectId() });
  }

  // [[ We do not need this - should be handled by first line in class ]]
  requireProjectId(): string {
    const projectId = this.name.projectId;
    if (!projectId) throw new Error("Project Durable Object must be project-scoped.");
    if (this.name.path !== "/") {
      throw new Error(`Project Durable Object must be at "/", got "${this.name.path}".`);
    }
    return projectId;
  }

  #stream(): HostStream {
    const streamName = formatDurableObjectName({
      projectId: this.name.projectId,
      path: this.name.path,
    });
    const stream = () => this.env.STREAM.getByName(streamName);
    return {
      append: (args: StreamAppendArgs) => stream().append(args),
      appendBatch: (args: StreamAppendBatchArgs) => stream().appendBatch(args),
    };
  }
}
