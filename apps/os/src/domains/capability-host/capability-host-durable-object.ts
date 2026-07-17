import { DurableObject, tracing } from "cloudflare:workers";
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
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import { checkCapabilityTypes, checkItxScriptForExecution } from "../typecheck/virtual-project.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostAncestor,
  type CapabilityHostProcessorReads,
} from "./capability-host-processor-implementation.ts";
import {
  CapabilityHostProcessorContract,
  type ScriptExecutionSettlement,
} from "./capability-host-processor-contract.ts";
import type { ScriptExecutionHandoff, ScriptExecutionIntent } from "./script-execution-driver.ts";
import type { ProvideCapabilityInput } from "./types.ts";
import { warmCapabilityHostDependencies } from "./capability-host-warmup.ts";

const SCRIPT_DEADLINE_ALARM_SLICE_PREFIX = "script-execution-deadline:";

type CapabilityHostAncestorEntrypoint = {
  warmCapabilityHostFromDescendant(visitedScopePaths: string[]): Promise<void>;
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
  // Registered WITH recovery: an explicit caller outside this host executes
  // userspace, while this host owns the durable obligation. If the host
  // disappears, its revival fact keeps requested work claimable only until
  // its armed deadline and never replays started work.
  readonly #capabilityHostProcessor = this.#registry.register(
    new CapabilityHostProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      itx: this.#itx,
      setScriptDeadline: (executionId, expiresAt) =>
        this.#setScriptDeadline(executionId, expiresAt),
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
  readonly #bootWarmup: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#bootWarmup = this.#warmCapabilityHost([], "boot").catch((error: unknown) => {
      console.error("[capability-host] boot warmup failed", {
        error,
        path: this.#name.path,
        projectId: this.#name.projectId,
      });
      throw error;
    });
    // Begin warming in the constructor, before the first RPC method runs, and
    // keep the incarnation alive until the explicit ancestor graph and the
    // typechecker compiler are ready. User-facing methods await the same
    // promise, so the first script cannot race this work.
    this.ctx.waitUntil(this.#bootWarmup);
  }

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
    const ancestor = this.#capabilityHostAncestorEntrypoint(ancestorPath);
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

  #capabilityHostAncestorEntrypoint(ancestorPath: string): CapabilityHostAncestorEntrypoint {
    return this.env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({ path: ancestorPath, projectId: this.#name.projectId }),
    ) as unknown as CapabilityHostAncestorEntrypoint;
  }

  async #warmCapabilityHost(
    visitedScopePaths: string[],
    reason: "boot" | "descendant",
  ): Promise<void> {
    await tracing.enterSpan(`capability_host.${reason}_warmup`, async (span) => {
      span.setAttribute("iterate.capability_host.path", this.#name.path);
      span.setAttribute("iterate.capability_host.project_id", this.#name.projectId);
      span.setAttribute("iterate.capability_host.warmup_reason", reason);
      await warmCapabilityHostDependencies({
        ancestorPath: () => this.#capabilityHostProcessor.ancestorPath(),
        catchUp: () => this.#catchUp(),
        path: this.#name.path,
        visitedScopePaths,
        warmAncestor: (ancestorPath, nextVisitedScopePaths) =>
          tracing.enterSpan("capability_host.ancestor_warmup", async (ancestorSpan) => {
            ancestorSpan.setAttribute("iterate.capability_host.path", this.#name.path);
            ancestorSpan.setAttribute("iterate.capability_host.ancestor_path", ancestorPath);
            await this.#capabilityHostAncestorEntrypoint(
              ancestorPath,
            ).warmCapabilityHostFromDescendant(nextVisitedScopePaths);
          }),
        warmTypechecker: () =>
          tracing.enterSpan("capability_host.typechecker_warmup", async (typecheckerSpan) => {
            typecheckerSpan.setAttribute("iterate.capability_host.path", this.#name.path);
            await this.env.TYPECHECKER.warm();
          }),
      });
    });
  }

  async #ready(): Promise<void> {
    await this.#bootWarmup;
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
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.invokeCapability(
      { args: input.args, path: input.path },
      input.visitedScopePaths,
    );
  }

  async describeCapabilitiesFromDescendant(
    visitedScopePaths: string[],
  ): Promise<CapabilityDescription[]> {
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.describeCapabilities(visitedScopePaths);
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /**
   * Internal boot traversal. This deliberately does not await #bootWarmup:
   * carrying the descendant's visited-path proof through the live traversal
   * is what turns a corrupt cycle into an explicit error instead of two cold
   * Durable Objects waiting on each other's cached boot promises.
   */
  async warmCapabilityHostFromDescendant(visitedScopePaths: string[]): Promise<void> {
    await this.#warmCapabilityHost(visitedScopePaths, "descendant");
  }

  /**
   * The registry's shared DO alarm. Processor keepalives and the earliest
   * script deadline occupy named slices; a deadline fire performs an
   * eventless at-head reconciliation so no open attempt can remain forever.
   */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#ready();
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
      // Pull journal truth, explicitly reconcile the clock-sensitive
      // obligations even when the stream head did not move, then fold any
      // exact settlements that reconciliation appended.
      await this.#catchUp();
      await this.#capabilityHostProcessor.reconcileScriptDeadlines();
      await this.#catchUp();
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

  async readStreamProcessor(request: ProcessorReadRequest): Promise<unknown> {
    await this.#ready();
    return await serveProcessorRead({
      expectedProcessorSlug: CapabilityHostProcessorContract.slug,
      processor: this.#processorRpc,
      request,
    });
  }

  // Return types are pinned shallow so `DurableObjectStub<CapabilityHostDurableObject>`
  // doesn't deep-instantiate the processor's inferred signatures (TS2589).
  async invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.invokeCapability(input);
  }

  async provideCapability(
    input: ProvideCapabilityInput,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.provideCapability(input);
  }

  async revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    await this.#ready();
    await this.#catchUp();
    await this.#capabilityHostProcessor.revokeCapability(input);
  }

  async requestScript(input: ScriptExecutionIntent): Promise<ScriptExecutionHandoff> {
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.requestScript(input);
  }

  /** Commit the exact executor outcome and return its authoritative stream event. */
  async settleScriptExecution(input: {
    executionId: string;
    settlement: ScriptExecutionSettlement;
  }): Promise<StreamEvent> {
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.settleScriptExecution(
      input.executionId,
      input.settlement,
    );
  }

  async describeCapabilities(): Promise<CapabilityDescription[]> {
    await this.#ready();
    await this.#catchUp();
    return await this.#capabilityHostProcessor.describeCapabilities();
  }

  async capabilityHostAncestorPath(): Promise<string | null> {
    await this.#ready();
    await this.#catchUp();
    return this.#capabilityHostProcessor.ancestorPath();
  }

  /**
   * Internal one-hop authority mint for the script executor's Dynamic Worker.
   * The executor binds the exact named CapabilityHost DO into the isolate;
   * this method creates a fresh scoped root in the authority-owning DO, so no
   * RpcStub is ever forwarded through an intermediate RPC session.
   */
  async getItxForScript(): Promise<object> {
    await this.#ready();
    return this.#itx;
  }

  #setScriptDeadline(executionId: string, expiresAt: number | null): Promise<void> {
    return this.#registry.setAlarmSlice(
      `${SCRIPT_DEADLINE_ALARM_SLICE_PREFIX}${executionId}`,
      expiresAt,
    );
  }
}
