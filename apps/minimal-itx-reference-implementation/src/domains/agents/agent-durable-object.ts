import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import type { StreamEvent } from "@iterate-com/os/src/domains/streams/engine/shared/event.ts";
import type { Env } from "../../env.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import { objectToPathInvoker, pathInvokerToProxy } from "../../itx/path-invoker.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { formatDurableObjectName, parseDurableObjectName } from "../durable-object-names.ts";
import { AgentProcessor, AgentProcessorContract } from "./agent-processor.ts";

type StreamStub = ReturnType<Env["STREAM"]["getByName"]>;
type StreamAppendArgs = Parameters<StreamStub["append"]>[0];
type StreamAppendBatchArgs = Parameters<StreamStub["appendBatch"]>[0];
type HostStream = {
  append(args: StreamAppendArgs): StreamEvent | Promise<StreamEvent>;
  appendBatch(args: StreamAppendBatchArgs): StreamEvent[] | Promise<StreamEvent[]>;
};

export class AgentDurableObject extends DurableObject<Env> {
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

  agentProcessor = this.host.add(
    AgentProcessorContract.slug,
    (deps) => new AgentProcessor({ ...deps }),
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
            capability: objectToPathInvoker(this, DurableObject.prototype),
            instructions: "the Agent Durable Object's public capability surface",
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

  invokeCapability(args: { path: string[]; args?: unknown[] }) {
    return this.itxProcessor.invokeCapability(args);
  }

  get project() {
    const project = this.env.PROJECT.getByName(
      formatDurableObjectName({ projectId: this.requireProjectId(), path: "/" }),
    );
    return pathInvokerToProxy(project);
  }

  whoami(): string {
    return `agent ${this.requireProjectId()}:${this.name.path}`;
  }

  async sendMessage(input: { message: string; channel?: string }) {
    const event = await this.#stream().append({
      event: {
        type: "events.iterate.com/agent/message-sent",
        payload: input,
      },
    });
    return { agent: this.whoami(), event, ...input };
  }

  requireProjectId(): string {
    const projectId = this.name.projectId;
    if (!projectId) throw new Error("Agent Durable Object must be project-scoped.");
    if (!this.name.path.startsWith("/agents/")) {
      throw new Error(
        `Agent Durable Object path must start with "/agents/", got "${this.name.path}".`,
      );
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
