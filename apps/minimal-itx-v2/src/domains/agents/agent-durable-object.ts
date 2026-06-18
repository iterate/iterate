import { DurableObject, env, RpcTarget } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import type { AgentRpc, ItxProcessorRpc } from "../../itx-types.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { formatDurableObjectName, parseDurableObjectName } from "../durable-object-names.ts";
import { ProjectRpcTarget } from "../projects/project-durable-object.ts";
import { AgentProcessor, AgentProcessorContract } from "./agent-processor.ts";

export class AgentDurableObject extends DurableObject<Env> implements AgentRpc {
  readonly #name = parseDurableObjectName(this.ctx.id.name!);
  readonly #host = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({ props: this.#name }),
    },
    facets: this.ctx.facets,
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
    storage: this.ctx.storage,
  });

  readonly #itxProcessor: ItxProcessorRpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host.add(AgentProcessorContract.slug, (deps) => new AgentProcessor(deps));
    this.#itxProcessor = this.#host.add(
      ItxContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkers: this.#dynamicWorkers,
          iterateContext: { stream: this.#stream },
        }),
    );
  }

  get itxProcessor(): ItxProcessorRpc {
    return this.#itxProcessor;
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#host.requestStreamSubscription(args);
  }

  project() {
    return new ProjectRpcTarget({ path: "/", projectId: this.#name.projectId });
  }

  whoami() {
    return `agent ${this.#name.projectId}:${this.#name.path}`;
  }

  async create(input: Record<string, unknown> = {}) {
    await this.#stream.append({
      event: {
        type: "events.iterate.com/agent/create-requested",
        payload: input,
      },
    });
    return await this.#stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/created"],
      predicate: () => true,
      timeoutMs: 5_000,
    });
  }

  async sendMessage(input: { channel?: string; message: string }) {
    const event = await this.#stream.append({
      event: {
        type: "events.iterate.com/agent/message-sent",
        payload: input,
      },
    });
    return { agent: this.whoami(), event, ...input };
  }
}

export class AgentRpcTarget extends RpcTarget implements AgentRpc {
  constructor(readonly props: { path: string; projectId: string }) {
    super();
  }

  create(input: Record<string, unknown> = {}) {
    return this.#stub().create(input);
  }

  project() {
    return new ProjectRpcTarget({ path: "/", projectId: this.props.projectId });
  }

  sendMessage(input: { channel?: string; message: string }) {
    return this.#stub().sendMessage(input);
  }

  whoami() {
    return this.#stub().whoami();
  }

  #stub() {
    return env.AGENT.getByName(formatDurableObjectName(this.props));
  }
}
