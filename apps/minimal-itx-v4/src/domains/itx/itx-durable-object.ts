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
  type ProvideCapabilityInput,
  type RunScriptResult,
} from "./itx-processor-implementation.ts";

export class ItxDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);
  readonly #itxProcessor = this.#processorHost.add(
    ItxProcessorContract.slug,
    (deps) =>
      new ItxProcessor({
        ...deps,
        dynamicWorkerRuntime: new DynamicWorkerRuntimeRpcTarget({
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
        }),
        host: this.#name,
        stream: this.ctx.exports.StreamDurableObject.getByName(
          this.#name.durableObjectName,
        ) as never,
      }),
  );

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  // Return types are pinned shallow so `DurableObjectStub<ItxDurableObject>`
  // doesn't deep-instantiate the processor's inferred signatures (TS2589).
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return this.#itxProcessor.invokeCapability(input);
  }

  provideCapability(input: ProvideCapabilityInput): Promise<{ path: string[] }> {
    return this.#itxProcessor.provideCapability(input);
  }

  revokeCapability(input: { path: string[] }): Promise<void> {
    return this.#itxProcessor.revokeCapability(input);
  }

  runScript(code: string): Promise<RunScriptResult> {
    return this.#itxProcessor.runScript(code);
  }
}
