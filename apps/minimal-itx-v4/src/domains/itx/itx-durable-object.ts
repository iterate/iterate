import { DurableObject } from "cloudflare:workers";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { DynamicWorkerRuntimeRpcTarget } from "../dynamic-workers/rpc-targets.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import { ItxProcessorContract } from "./itx-processor-contract.ts";
import {
  ItxProcessor,
  type ItxProcessorRpc,
  type ProvideCapabilityInput,
} from "./itx-processor-implementation.ts";

export class ItxDurableObject extends DurableObject<Env> implements ItxProcessorRpc {
  readonly #name = DurableObjectNameCodec.parseProjectScoped(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  readonly #dynamicWorkerRuntime = new DynamicWorkerRuntimeRpcTarget({
    bindings: {
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

    if (this.#name.path !== "/" && !this.#name.path.startsWith("/agents/")) {
      throw new Error(
        `ITX Durable Object path must be "/" or "/agents/...", got "${this.#name.path}"`,
      );
    }

    this.#itxProcessor = this.#processorHost.add(
      ItxProcessorContract.slug,
      (deps) =>
        new ItxProcessor({
          ...deps,
          dynamicWorkerRuntime: this.#dynamicWorkerRuntime,
          host: {
            ...(this.#name.path === "/" ? {} : { agentPath: this.#name.path }),
            projectId: this.#name.projectId,
          },
          stream: this.#stream as never,
        }),
    );
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  invokeCapability(input: { args?: unknown[]; path: string[] }) {
    return this.#itxProcessor.invokeCapability(input);
  }

  provideCapability(input: ProvideCapabilityInput) {
    return this.#itxProcessor.provideCapability(input);
  }

  revokeCapability(input: { path: string[] }) {
    return this.#itxProcessor.revokeCapability(input);
  }

  runScript(code: string) {
    return this.#itxProcessor.runScript(code);
  }
}
