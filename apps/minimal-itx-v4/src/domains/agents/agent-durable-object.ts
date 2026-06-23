import { DurableObject } from "cloudflare:workers";
import type { Agent, RpcTargetImplementation } from "../../../types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN, trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { ItxProcessor, type ItxProcessorRpc } from "../../itx/processor.ts";
import { ItxContract } from "../../itx/processor-contract.ts";
import { AgentRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { DynamicWorkersRpcTarget } from "../dynamic-workers/dynamic-workers-rpc-target.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import { AgentProcessor, AgentProcessorContract } from "./agent-processor.ts";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parseProjectScoped(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkers = new DynamicWorkersRpcTarget({
    bindings: {
      // The binding is intentionally the boring unauthenticated root. Script
      // workers authenticate and then walk to project/agent from their own
      // entrypoint props; the ITX binding itself never bakes in a context.
      ITX: this.ctx.exports.ItxEntrypoint({
        props: {
          type: "trusted-internal",
          token: TRUSTED_INTERNAL_ITX_TOKEN,
        },
      }),
    },
    facets: this.ctx.facets,
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
    storage: this.ctx.storage,
  });

  readonly #itxProcessor: ItxProcessorRpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (!this.#name.path.startsWith("/agents/")) {
      throw new Error(
        `Agent Durable Object path must start with "/agents/", got "${this.#name.path}"`,
      );
    }

    this.#processorHost.add(AgentProcessorContract.slug, (deps) => new AgentProcessor(deps));

    this.#itxProcessor = this.#processorHost.add(
      ItxContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkers: this.#dynamicWorkers,
          host: { agentPath: this.#name.path, projectId: this.#name.projectId },
          stream: this.#stream as never,
        }),
    );
  }

  get itxProcessor(): ItxProcessorRpc {
    return this.#itxProcessor;
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  getCapability(): RpcTargetImplementation<Agent> {
    return new AgentRpcTarget({
      auth: trustedInternalAuthContext(),
      ctx: this.ctx,
      path: this.#name.path,
      projectId: this.#name.projectId,
    });
  }

  get rpcTarget(): RpcTargetImplementation<Agent> {
    return this.getCapability();
  }

  get stream(): RpcTargetImplementation<Agent>["stream"] {
    return this.getCapability().stream;
  }

  whoami() {
    return this.getCapability().whoami();
  }

  create() {
    return this.getCapability().create();
  }

  sendMessage(message: string) {
    return this.getCapability().sendMessage(message);
  }

  ask(input: Parameters<Agent["ask"]>[0]) {
    return this.getCapability().ask(input);
  }

  runScript(code: string) {
    return this.#itxProcessor.runScript(code);
  }

  async provideCapability(input: Parameters<Agent["provideCapability"]>[0]) {
    await this.#itxProcessor.provideCapability(input);
    return {
      revoke: () => this.revokeCapability({ path: input.path }),
    };
  }

  revokeCapability(input: Parameters<Agent["revokeCapability"]>[0]) {
    return this.#itxProcessor.revokeCapability(input);
  }
}
