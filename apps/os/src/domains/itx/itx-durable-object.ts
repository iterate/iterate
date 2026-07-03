import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { CapabilityDescription } from "../../types.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec, parentScopePath } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { ItxRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { KvWorkerBuildArtifactStore, type WorkerBuildArtifact } from "../workers/artifact-store.ts";
import { WorkerBuildProcessor } from "../workers/worker-build-processor-implementation.ts";
import {
  ItxProcessor,
  type ParentItxScope,
  type ProvideCapabilityInput,
  type RunScriptResult,
} from "./itx-processor-implementation.ts";
import { itxEntrypointBinding, itxEntrypointProps, itxEntrypointScopeCacheKey } from "./utils.ts";

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
    (deps) =>
      new ItxProcessor({
        ...deps,
        itx: new ItxRpcTarget({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          itxPath: this.#name.path,
          projectId: this.#name.projectId,
        }),
        // The enclosing scope, so a capability miss at this path falls through to
        // the surrounding scope (agent → its namespace → the project). Only the
        // immediate parent is wired; deeper ancestors are reached because that
        // parent applies the same fallback. Undefined at the root, which ends the
        // chain.
        parent: this.#parentItxScope(),
        path: this.#name.path,
        workerRunner: new DynamicWorkerRunner({
          bindings: {
            ITX: itxEntrypointBinding(this.ctx.exports, this.#itxScope),
          },
          globalOutbound: projectEgressFetcher(this.ctx.exports, this.#name.projectId),
          loader: this.env.LOADER,
          projectId: this.#name.projectId,
          workerScopeKey: itxEntrypointScopeCacheKey(this.#itxScope),
        }),
      }),
  );
  // Installed wherever the ITX processor is installed: any scope that can run
  // ITX dynamic work is a scope whose stream owns worker build lifecycle. The
  // repo domain stays a file source only — build coordination lives here.
  readonly #workerBuildProcessor = this.#processorHost.add(
    (deps) =>
      new WorkerBuildProcessor({
        ...deps,
        artifactStore: new KvWorkerBuildArtifactStore(this.env.WORKER_BUILD_CACHE),
        repoSnapshot: (source) =>
          this.env.REPO.getByName(
            DurableObjectNameCodec.stringify({
              path: source.repoPath,
              projectId: this.#name.projectId,
            }),
          ).getFilesSnapshot({
            branch: source.branch,
            commitOid: source.commitOid,
            exclude: source.exclude,
            include: source.include,
          }),
      }),
  );

  #parentItxScope(): ParentItxScope | undefined {
    const parentPath = parentScopePath(this.#name.path);
    if (parentPath === null) return undefined;
    const parent = this.env.ITX.getByName(
      DurableObjectNameCodec.stringify({ path: parentPath, projectId: this.#name.projectId }),
    );
    // Forward only the two read methods the child scope chains through. Handing the
    // full DurableObjectStub over as a typed dependency makes TypeScript instantiate
    // the DO's self-referential stub type (TS2589); a thin forwarder keeps it shallow.
    return {
      invokeCapability: (input) => parent.invokeCapability(input),
      describeCapabilities: () => parent.describeCapabilities(),
    };
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#itxProcessor);
  }

  get workerBuildProcessor() {
    return new StreamProcessorRpcTarget(this.#workerBuildProcessor);
  }

  /**
   * Artifact read with read-your-write KV semantics: this Durable Object's
   * build processor wrote the artifact from HERE, so a read from here sees it
   * even while cross-location KV propagation (~60s) is still in flight. The
   * resolver falls back to this after a `completed` event when its own
   * location's KV read misses.
   */
  getWorkerBuildArtifact(input: { buildKey: string }): Promise<WorkerBuildArtifact | null> {
    return new KvWorkerBuildArtifactStore(this.env.WORKER_BUILD_CACHE).get(input.buildKey);
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
    return this.#itxProcessor.describeCapabilities();
  }
}
