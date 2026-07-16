import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { createStreamProcessorRegistry } from "../streams/stream-processor-registry.ts";
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
  type RunScriptResult,
} from "./capability-host-processor-implementation.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import type { ProvideCapabilityInput } from "./types.ts";

type ScriptExecutionEntrypoint = {
  run(code: string, options?: { emittedJs?: string }): Promise<unknown>;
};

type ScriptExecutionLoopbackExports = {
  ScriptExecutionEntrypoint(input: {
    props: {
      projectId: string;
      scopePath: string;
    };
  }): ScriptExecutionEntrypoint;
};

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
  // `runInBackground` work (journaled requested/started obligations whose
  // OUTCOME matters), so an incarnation that dies owing one must be revived —
  // the keepalive alarm appends the `stream/processor-revived` fact, whose ordinary
  // delivery lands at head and `processEvent`'s at-head reconcile
  // (`delivery.caughtUp`) re-drives the obligations (see the registry module
  // doc's recovery rule).
  readonly #capabilityHostProcessor = this.#registry.register(
    new CapabilityHostProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      itx: itxForScope({
        auth: trustedInternalAuthContext(),
        ctx: this.ctx,
        path: this.#name.path,
        projectId: this.#name.projectId,
      }),
      // Resolve only the durable ancestor declaration folded by the
      // processor. Namespace path prefixes are never dialed implicitly.
      resolveAncestor: (path) => this.#capabilityHostAncestor(path),
      reads: this.#processorReads(),
      scriptExecutionEntrypoint: this.#scriptExecutionEntrypoint(),
      validateCapabilityTypes: (types) =>
        checkCapabilityTypes({ types, typechecker: this.env.TYPECHECKER }),
      typecheckScript: (input) =>
        checkItxScriptForExecution({ ...input, typechecker: this.env.TYPECHECKER }),
      // runScript has already journaled and folded the requested obligation;
      // launch it through the SAME recovery-backed runner lane as an at-head
      // reconcile, without waiting for the subscription transport to produce
      // another consumed event.
      runScriptInBackground: (work) =>
        this.#registry.runInBackground(CapabilityHostProcessorContract.slug, work),
    }),
    { recovery: true },
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (the processor facade, the processor's own fold
  // reads via #processorReads) goes through the runner's committed progress.
  readonly #reads = this.#registry.reads(this.#capabilityHostProcessor);

  /** The processor's runner-backed fold reads — lazy closures because #reads
   * is built from the registered processor above; the explicit return type
   * breaks the field-initializer inference cycle. */
  #processorReads(): CapabilityHostProcessorReads {
    return {
      snapshot: () => this.#reads.snapshot(),
      waitUntilEvent: (input) => this.#reads.waitUntilEvent(input),
    };
  }

  #scriptExecutionEntrypoint(): ScriptExecutionEntrypoint {
    // Scripts execute in THIS scope, but the Dynamic Worker load happens in a
    // stateless loopback entrypoint instead of this Durable Object. Keep the
    // type shallow to avoid deep-instantiating the generated `ctx.exports`
    // WorkerEntrypoint type through the Durable Object's processor field.
    const exports = this.ctx.exports as unknown as ScriptExecutionLoopbackExports;
    return exports.ScriptExecutionEntrypoint({
      props: {
        scopePath: this.#name.path,
        projectId: this.#name.projectId,
      },
    });
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

  async runScript(code: string): Promise<RunScriptResult> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.runScript(code);
  }

  async describeCapabilities(): Promise<CapabilityDescription[]> {
    await this.#catchUp();
    return await this.#capabilityHostProcessor.describeCapabilities();
  }

  async capabilityHostAncestorPath(): Promise<string | null> {
    await this.#catchUp();
    return this.#capabilityHostProcessor.ancestorPath();
  }
}
