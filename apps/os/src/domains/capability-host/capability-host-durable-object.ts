import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { createStreamProcessorRegistry } from "../streams/stream-processor-registry.ts";
import { serveProcessorRead, type ProcessorReadRequest } from "../streams/processor-rpc.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import { checkCapabilityTypes, checkItxScriptForExecution } from "../typecheck/virtual-project.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostAncestor,
  type CapabilityHostProcessorReads,
  type ScriptRunRequest,
} from "./capability-host-processor-implementation.ts";
import {
  CapabilityHostProcessorContract,
  DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
  type ScriptExecutionSettlement,
} from "./capability-host-processor-contract.ts";
import type { ProvideCapabilityInput } from "./types.ts";

const SCRIPT_DEADLINE_ALARM_SLICE = "script-execution-deadline";

type CapabilityHostAncestorEntrypoint = {
  invokeCapabilityFromDescendant(input: {
    args?: unknown[];
    path: string[];
    visitedScopePaths: string[];
  }): Promise<unknown>;
  describeCapabilitiesFromDescendant(visitedScopePaths: string[]): Promise<CapabilityDescription[]>;
};

/**
 * One capability scope: the durable dynamic-capability table and script
 * journal at one `{projectId, path}`. `provideCapability` always mounts here;
 * `invokeCapability`/`describeCapabilities` follow the host's durable,
 * explicit ancestor declaration on a local miss.
 */
export class CapabilityHostDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #itx = itxForScope({
    auth: trustedInternalAuthContext(),
    ctx: this.ctx,
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
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
  // Registered WITH recovery: the foreground ITX request executes userspace,
  // but this host still owns the durable obligation. If the host disappears,
  // its revival fact reconciles provably-unstarted requests immediately and
  // never replays started work.
  readonly #capabilityHostProcessor = this.#registry.register(
    new CapabilityHostProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      itx: this.#itx,
      // Resolve only the durable ancestor declaration folded by the
      // processor. Namespace path prefixes are never dialed implicitly.
      resolveAncestor: (path) => this.#capabilityHostAncestor(path),
      reads: this.#processorReads(),
      validateCapabilityTypes: (types) =>
        checkCapabilityTypes({ types, typechecker: this.env.TYPECHECKER }),
      typecheckScript: (input) =>
        checkItxScriptForExecution({ ...input, typechecker: this.env.TYPECHECKER }),
    }),
    { recovery: true },
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (the processor facade, the processor's own fold
  // reads via #processorReads) goes through the runner's committed progress.
  readonly #reads = this.#registry.reads(this.#capabilityHostProcessor);
  readonly #processorRpc = new StreamProcessorRpcTarget(this.#reads, {
    catchUpBeforeSnapshot: () => this.#registry.catchUp(CapabilityHostProcessorContract.slug),
  });

  /** The processor's runner-backed fold reads — lazy closures because #reads
   * is built from the registered processor above; the explicit return type
   * breaks the field-initializer inference cycle. */
  #processorReads(): CapabilityHostProcessorReads {
    return {
      snapshot: () => this.#reads.snapshot(),
      waitUntilEvent: (input) => this.#reads.waitUntilEvent(input),
    };
  }

  #capabilityHostAncestor(ancestorPath: string): CapabilityHostAncestor {
    const ancestor = this.env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({ path: ancestorPath, projectId: this.#name.projectId }),
    ) as unknown as CapabilityHostAncestorEntrypoint;
    // Forward only the two internal read methods. Handing the full stub over as
    // a typed dependency makes TypeScript instantiate the DO's self-referential
    // stub type (TS2589); this thin forwarder also keeps the traversal proof out
    // of the public capability-host surface.
    return {
      invokeCapability: (input, visitedScopePaths = []) =>
        ancestor.invokeCapabilityFromDescendant({ ...input, visitedScopePaths }),
      describeCapabilities: (visitedScopePaths = []) =>
        ancestor.describeCapabilitiesFromDescendant(visitedScopePaths),
    };
  }

  /**
   * A Durable Object incarnation starts with only the processor's schema
   * default in memory. Pull the journal before every stateful public operation
   * so eviction can never turn a durably born host back into an unconfigured
   * one, and so an asynchronous stream wake is not a read-your-writes race.
   */
  async #catchUp(): Promise<void> {
    await this.#registry.catchUp(CapabilityHostProcessorContract.slug);
  }

  async invokeCapabilityFromDescendant(input: {
    args?: unknown[];
    path: string[];
    visitedScopePaths: string[];
  }): Promise<unknown> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.invokeCapability(
      { args: input.args, path: input.path },
      input.visitedScopePaths,
    );
  }

  async describeCapabilitiesFromDescendant(
    visitedScopePaths: string[],
  ): Promise<CapabilityDescription[]> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.describeCapabilities(visitedScopePaths);
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /**
   * The registry's shared DO alarm. Processor keepalives and the earliest
   * script deadline occupy named slices; a deadline fire performs an
   * eventless at-head reconciliation so no open attempt can remain forever.
   */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#registry.handleAlarm(alarmInfo);
    } catch (error) {
      failures.push(error);
    }
    try {
      // Run on every alarm, including a retry after the registry already
      // consumed the in-memory deadline slice. This makes the journal—not an
      // incarnation-local marker—the source from which deadlines recover.
      // First pass appends any recovery settlements inline; the second folds
      // those exact events before deriving the next deadline slice.
      await this.#catchUp();
      await this.#catchUp();
      await this.#armNextScriptDeadline();
    } catch (error) {
      console.error("[capability-host] script deadline alarm reconciliation failed", { error });
      failures.push(error);
    }
    if (failures.length > 0) throw failures[0];
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  readStreamProcessor(request: ProcessorReadRequest): Promise<unknown> {
    return serveProcessorRead({
      expectedProcessorSlug: CapabilityHostProcessorContract.slug,
      processor: this.#processorRpc,
      request,
    });
  }

  // Return types are pinned shallow so `DurableObjectStub<CapabilityHostDurableObject>`
  // doesn't deep-instantiate the processor's inferred signatures (TS2589).
  async invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.invokeCapability(input);
  }

  async provideCapability(
    input: ProvideCapabilityInput,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.provideCapability(input);
  }

  async revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    await this.#catchUp();
    await this.#capabilityHostProcessor.revokeCapability(input);
  }

  async requestScript(code: string): Promise<ScriptRunRequest> {
    await this.#catchUp();
    const expiresAt = Date.now() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS;
    try {
      // Arm before journaling. A crash in any later request/typecheck/start
      // gap therefore leaves a durable alarm that can classify the obligation
      // without ever replaying userspace.
      await this.#armScriptDeadline(expiresAt);
    } catch (error) {
      throw new Error(
        "Script was NOT accepted: its capability host could not durably arm the absolute execution deadline. It never ran.",
        { cause: error },
      );
    }
    return await this.#capabilityHostProcessor.requestScript(code, { expiresAt });
  }

  /** Commit the exact executor outcome supplied by the top-level ITX request. */
  async settleScriptExecution(input: {
    executionId: string;
    settlement: ScriptExecutionSettlement;
  }): Promise<void> {
    await this.#catchUp();
    await this.#capabilityHostProcessor.settleScriptExecution(input.executionId, input.settlement);
  }

  async describeCapabilities(): Promise<CapabilityDescription[]> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.describeCapabilities();
  }

  async capabilityHostAncestorPath(): Promise<string | null> {
    await this.#catchUp();
    return this.#capabilityHostProcessor.ancestorPath();
  }

  /**
   * Internal one-hop authority mint for the script executor's Dynamic Worker.
   * The executor binds the exact named CapabilityHost DO into the isolate;
   * this method creates a fresh scoped root in the authority-owning DO, so no
   * RpcStub is ever forwarded through an intermediate RPC session.
   */
  getItxForScript(): object {
    return this.#itx;
  }

  async #armScriptDeadline(expiresAt: number): Promise<void> {
    const armed = this.#registry.getAlarmSlice(SCRIPT_DEADLINE_ALARM_SLICE);
    if (armed === null || expiresAt < armed) {
      await this.#registry.setAlarmSlice(SCRIPT_DEADLINE_ALARM_SLICE, expiresAt);
    }
  }

  async #armNextScriptDeadline(): Promise<void> {
    const { state } = await this.#reads.snapshot();
    const deadlines = Object.values(state.scriptExecutions).map(({ expiresAt }) => expiresAt);
    // A new request can arm its future deadline while this alarm is awaiting
    // the snapshot but before its request event exists. Re-read the synchronous
    // slice after the await and preserve it so reconciliation cannot clobber
    // that pre-journal safety net.
    const concurrentlyArmed = this.#registry.getAlarmSlice(SCRIPT_DEADLINE_ALARM_SLICE);
    if (concurrentlyArmed !== null) deadlines.push(concurrentlyArmed);
    await this.#registry.setAlarmSlice(
      SCRIPT_DEADLINE_ALARM_SLICE,
      deadlines.length === 0 ? null : Math.min(...deadlines),
    );
  }
}
