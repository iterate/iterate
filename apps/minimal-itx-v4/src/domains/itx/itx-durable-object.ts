import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { CapabilityDescription } from "../../types.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../streams/stream-processor.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { ItxProcessorContract } from "./itx-processor-contract.ts";
import {
  ItxProcessor,
  type ProvideCapabilityInput,
  type RunScriptResult,
} from "./itx-processor-implementation.ts";
import { itxEntrypointProps, itxEntrypointScopeCacheKey } from "./utils.ts";

export class ItxDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  // The host-supplied ITX binding scope and Worker Loader cache scope must be
  // built from the same normalized value, otherwise a worker can load with one
  // scope key and resolve `env.ITX.get()` against a different path.
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
        egress: projectEgressFetcher(this.ctx.exports, this.#name.projectId),
        path: this.#name.path,
        workerRunner: new DynamicWorkerRunner({
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

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#itxProcessor);
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

  describeCapabilities(): Promise<CapabilityDescription[]> {
    return Promise.resolve(this.#itxProcessor.describeCapabilities());
  }
}
