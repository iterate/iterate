import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import { projectEgressFetcher } from "../projects/egress.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { WorkerRunner } from "../workers/worker-runner.ts";
import { ItxProcessorContract } from "./itx-processor-contract.ts";
import {
  ItxProcessor,
  type ProvideCapabilityInput,
  type RunScriptResult,
} from "./itx-processor-implementation.ts";
import { itxEntrypointProps, itxEntrypointScopeCacheKey } from "./entrypoint-props.ts";

export class ItxDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  // [[ Overly abstract / verbose? can be deleted i hope? ]]
  readonly #itxScope = itxEntrypointProps({
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #itxProcessor = this.#processorHost.add(
    ItxProcessorContract.slug,
    (deps) =>
      new ItxProcessor({
        ...deps,
        path: this.#name.path,
        workerRunner: new WorkerRunner({
          bindings: {
            ITX: this.ctx.exports.ItxEntrypoint({
              props: this.#itxScope,
            }),
          },
          globalOutbound: projectEgressFetcher(this.ctx.exports, this.#name.projectId),
          loader: this.env.LOADER,
          projectId: this.#name.projectId,
          workerScopeKey: itxEntrypointScopeCacheKey(this.#itxScope),
        }),
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

  provideCapability(
    input: ProvideCapabilityInput,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    return this.#itxProcessor.provideCapability(input);
  }

  revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    return this.#itxProcessor.revokeCapability(input);
  }

  runScript(code: string): Promise<RunScriptResult> {
    return this.#itxProcessor.runScript(code);
  }
}
