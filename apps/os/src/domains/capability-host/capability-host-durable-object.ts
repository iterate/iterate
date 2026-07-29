import { DurableObject } from "cloudflare:workers";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import {
  workerDeploymentVersionRpcResponse,
  workerVersion,
  type Env,
  type WorkerDeploymentVersion,
  type WorkerDeploymentVersionFormat,
} from "../../env.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import type { StreamContext } from "../projects/stream-context.ts";
import { checkCapabilityTypes, checkItxScriptForExecution } from "../typecheck/virtual-project.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorReads,
} from "./capability-host-processor-implementation.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { scriptExecutionDurableObjectName } from "./script-execution-durable-object.ts";
import type { ProvideCapabilityInput } from "./types.ts";

type ScriptExecutionExecutor = {
  start(
    code: string,
    options: {
      emittedJs?: string;
      executionExpiresAt: number;
      settlementExpiresAt: number;
      streamContext: Extract<StreamContext, { kind: "script-execution" }>;
      streamId: string;
    },
  ): Promise<void>;
};

/**
 * One capability scope: the durable dynamic-capability table and script
 * stream at one `{projectId, path}`. `provideCapability` always mounts here;
 * `invokeCapability`/`describeCapabilities` follow the birth certificate's
 * committed `fallback` expression (usually straight to the project root's
 * host) on a local miss.
 */
export class CapabilityHostDurableObject extends DurableObject<Env> {
  /** Report the incarnation version at the safe pre-script-request boundary.
   * No argument preserves the legacy string RPC contract; new callers opt in
   * to ordering metadata so both sides of a rollout remain compatible. */
  deploymentVersion(): string;
  deploymentVersion(format: WorkerDeploymentVersionFormat): WorkerDeploymentVersion;
  deploymentVersion(format?: WorkerDeploymentVersionFormat): WorkerDeploymentVersion | string {
    return format === undefined
      ? workerDeploymentVersionRpcResponse(this.env)
      : workerDeploymentVersionRpcResponse(this.env, format);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  // The DO constructs the processor — no host-injected readState/writeState/
  // keepAliveWhile deps; the runner owns durable progress and keepalive.
  // Registered WITH recovery: script executions are consequential
  // `runInBackground` work (stream-committed requested/started obligations
  // whose OUTCOME matters), so an incarnation that dies owing one must be
  // revived — the keepalive alarm appends the `stream/processor-revived` fact,
  // whose wake produces the eventless at-head pass (`delivery.caughtUp`) that
  // re-drives the obligations (see the registry module doc's recovery rule).
  readonly #capabilityHostProcessor = this.#registry.register(
    new CapabilityHostProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      itx: itxForScope({
        auth: trustedInternalAuthContext(),
        ctx: this.ctx,
        streamContext: { kind: "scope", scopePath: this.#name.path },
        path: this.#name.path,
        projectId: this.#name.projectId,
      }),
      reads: this.#processorReads(),
      scriptExecutionExecutor: this.#scriptExecutionExecutor(),
      validateCapabilityTypes: (types) =>
        checkCapabilityTypes({ types, typechecker: this.env.TYPECHECKER }),
      typecheckScript: (input) =>
        checkItxScriptForExecution({ ...input, typechecker: this.env.TYPECHECKER }),
    }),
    { recovery: true },
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (the processor facade, the processor's own state
  // reads via #processorReads) goes through the runner's committed progress.
  readonly #reads = this.#registry.reads(this.#capabilityHostProcessor);

  /** The processor's runner-backed state reads — lazy closures because #reads
   * is built from the registered processor above; the explicit return type
   * breaks the field-initializer inference cycle. */
  #processorReads(): CapabilityHostProcessorReads {
    return {
      snapshot: () => this.#reads.snapshot(),
      waitUntilEvent: (input) => this.#reads.waitUntilEvent(input),
    };
  }

  #scriptExecutionExecutor(): ScriptExecutionExecutor {
    // The host records `started`, then hands the immutable execution to its
    // own alarm-backed Durable Object. The scope, stream lifetime, and local
    // execution id together address a globally unique DO, which is the
    // at-most-once fence across host retries and evictions.
    return {
      start: async (code, options) => {
        const executionOptions = {
          ...options,
          projectId: this.#name.projectId,
          scopePath: this.#name.path,
        };
        const executorName = await scriptExecutionDurableObjectName(executionOptions);
        await this.env.SCRIPT_EXECUTION.getByName(executorName).start(code, executionOptions);
      },
    };
  }

  wakeStreamProcessor(args: StreamProcessorWakeRequest): Promise<StreamProcessorWakeResponse> {
    return this.#registry.wakeStreamProcessor(args);
  }

  /** The registry's shared DO alarm (runner keepalives) — see stream-processor-registry.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    // Runner-backed reads (#reads), never the processor instance — see the
    // field comment: instance reads are stale forever under runner drive.
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(CapabilityHostProcessorContract.slug),
    });
  }

  // Return types are pinned shallow so `DurableObjectStub<CapabilityHostDurableObject>`
  // doesn't deep-instantiate the processor's inferred signatures (TS2589).
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return this.#capabilityHostProcessor.invokeCapability(input);
  }

  provideCapability(
    input: ProvideCapabilityInput,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    return this.#capabilityHostProcessor.provideCapability(input);
  }

  revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    return this.#capabilityHostProcessor.revokeCapability(input);
  }

  describeCapabilities(): Promise<CapabilityDescription[]> {
    return this.#capabilityHostProcessor.describeCapabilities();
  }
}
