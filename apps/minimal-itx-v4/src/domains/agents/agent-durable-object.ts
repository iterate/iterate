import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import type { Agent, AgentItx, StreamEvent } from "../../../types-and-schemas.ts";
import type { ItxProcessorRpc } from "../../itx/processor.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { ItxProcessor } from "../../itx/processor.ts";
import { AgentItx as AgentItxTarget, ProjectItx, StreamTarget } from "../../rpc_targets.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import { parseDurableObjectName } from "../durable-object-names.ts";
import { AgentProcessor, AgentProcessorContract } from "./agent-processor.ts";

type InternalStreamWriter = {
  append(input: unknown): Promise<unknown>;
};

export class AgentDurableObject extends DurableObject<Env> implements Agent {
  readonly #name = parseDurableObjectName(this.ctx.id.name!);
  readonly #host = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      ITX: this.ctx.exports.ItxEntrypoint({
        props: {
          ...this.#name,
          auth: { type: "trusted-internal", token: TRUSTED_INTERNAL_ITX_TOKEN },
        },
      }),
    },
    facets: this.ctx.facets,
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
    storage: this.ctx.storage,
  });

  readonly #itxProcessor: ItxProcessorRpc;

  #streamWriter(): InternalStreamWriter {
    return this.#stream as unknown as InternalStreamWriter;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host.add(AgentProcessorContract.slug, (deps) => new AgentProcessor(deps));
    this.#itxProcessor = this.#host.add(
      ItxContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkers: this.#dynamicWorkers,
          stream: this.#stream as never,
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
    return new ProjectItx({
      auth: trustedInternalAuthContext(),
      path: "/",
      projectId: this.#name.projectId,
    });
  }

  get itx(): AgentItx {
    return new AgentItxTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }) as unknown as AgentItx;
  }

  get stream(): Agent["stream"] {
    return new StreamTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }) as unknown as Agent["stream"];
  }

  whoami() {
    return `agent ${this.#name.projectId}:${this.#name.path}`;
  }

  async create(): Promise<StreamEvent> {
    await this.#streamWriter().append({
      event: {
        type: "events.iterate.com/agent/create-requested",
        payload: {},
      },
    });
    const event = await this.#streamWriter().append({
      event: {
        type: "events.iterate.com/agent/created",
        idempotencyKey: `agent-created:${this.#name.projectId}:${this.#name.path}`,
        payload: {},
      },
    });
    return event as StreamEvent;
  }

  async sendMessage(message: string): Promise<StreamEvent> {
    return (await this.#streamWriter().append({
      event: {
        type: "events.iterate.com/agent/message-sent",
        payload: { message },
      },
    })) as StreamEvent;
  }

  async runScript(code: string) {
    return await this.#itxProcessor.runScript(code);
  }

  async provideCapability(input: Parameters<Agent["provideCapability"]>[0]) {
    await this.#itxProcessor.provideCapability(input);
    return {
      revoke: () => {
        void this.revokeCapability({ path: input.path });
      },
    };
  }

  revokeCapability(input: Parameters<Agent["revokeCapability"]>[0]) {
    return this.#itxProcessor.revokeCapability(input);
  }
}
