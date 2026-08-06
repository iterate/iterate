import { DurableObject } from "cloudflare:workers";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { checkCapabilityTypes, checkItxScriptForExecution } from "../typecheck/virtual-project.ts";
import { sameCapabilityPath } from "./capability-path.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorReads,
} from "./capability-host-processor-implementation.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import type { ScriptExecutionSettlement } from "./script-execution-settlement.ts";
import {
  LiveCapabilityLegRpcTarget,
  LiveCapabilityLeaseServer,
  type LiveCapabilityLeaseActivation,
} from "./live-capability-lease.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityRecord,
  LiveCapabilityProviderBinding,
  RevokeCapabilityInput,
} from "./types.ts";

type LiveCapabilityRecord = Extract<CapabilityRecord, { type: "live" }>;

type ScriptExecutionEntrypoint = {
  run(
    code: string,
    options: { emittedJs?: string; expiresAt: number },
  ): Promise<ScriptExecutionSettlement>;
};

type ScriptExecutionLoopbackExports = {
  ScriptExecutionEntrypoint(input: {
    props: {
      projectId: string;
      scopePath: string;
    };
  }): ScriptExecutionEntrypoint;
};

/**
 * One capability scope: the durable dynamic-capability table and script
 * stream at one `{projectId, path}`. `provideCapability` always mounts here;
 * `invokeCapability`/`describeCapabilities` follow the birth certificate's
 * committed `fallback` expression (usually straight to the project root's
 * host) on a local miss.
 */
export class CapabilityHostDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
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
  readonly #liveCapabilityLeases = new LiveCapabilityLeaseServer({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  #capabilityMutationTail = Promise.resolve();
  #liveLeaseReconciliation: Promise<void> | undefined;
  #liveLeasesReconciled = false;
  #liveLeaseRevision = 0;
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
      invokeLiveCapability: (record, path, args) =>
        this.#liveCapabilityLeases.invoke(record, path, args),
      scriptExecutionEntrypoint: this.#scriptExecutionEntrypoint(),
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
  async invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    await this.#reconcileLiveCapabilityLeases();
    return await this.#capabilityHostProcessor.invokeCapability(input);
  }

  async provideCapability(
    input: CapabilityProvidedPayload,
    liveLease?: LiveCapabilityProviderBinding,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    await this.#reconcileLiveCapabilityLeases();
    if (input.type === "live" && liveLease === undefined) {
      throw new Error("live capability provision requires a hibernatable provider lease");
    }
    if (
      input.type === "live" &&
      liveLease !== undefined &&
      input.providerBinding.socketId !== liveLease.socketId
    ) {
      throw new Error("live capability provision does not belong to its hibernatable socket");
    }
    return await this.#serializeMutation(async () => {
      const { state } = await this.#reads.snapshot();
      if (
        input.type === "live" &&
        state.capabilities.some(
          (record) =>
            record.type === "live" &&
            record.providerBinding.socketId === input.providerBinding.socketId,
        )
      ) {
        throw new Error("a live capability socket can mount only one provision");
      }
      const replaced = state.capabilities.find((record) =>
        sameCapabilityPath(record.path, input.path),
      );
      return await this.#capabilityHostProcessor.provideCapability(input, {
        afterAppend: (record) => {
          // The append has already displaced this row. Retire its relay even
          // if binding the replacement fails; otherwise the old ownership
          // handle would remain active for a mount the table no longer holds.
          if (replaced?.type === "live") this.#liveCapabilityLeases.remove(replaced);
          if (input.type === "live") {
            if (liveLease === undefined) {
              throw new Error("live capability provision lost its validated provider lease");
            }
            if (record.type !== "live") {
              throw new Error("live capability provision committed a non-live record");
            }
            if (!this.#liveCapabilityLeases.bindProvision(record, liveLease.socketId)) {
              throw new Error(`live capability "${input.path.join(".")}" lease socket disappeared`);
            }
          }
        },
      });
    });
  }

  async revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    await this.#reconcileLiveCapabilityLeases();
    await this.#serializeMutation(async () => {
      const { state } = await this.#reads.snapshot();
      const record = state.capabilities.find((candidate) =>
        sameCapabilityPath(candidate.path, input.path),
      );
      await this.#capabilityHostProcessor.revokeCapability(input);
      if (
        record?.type === "live" &&
        (input.providedAtOffset === undefined || input.providedAtOffset === record.providedAtOffset)
      ) {
        this.#liveCapabilityLeases.remove(record);
      }
    });
  }

  async activateLiveCapability(
    input: LiveCapabilityLeaseActivation,
  ): Promise<LiveCapabilityLegRpcTarget | undefined> {
    await this.#reconcileLiveCapabilityLeases();
    const { state } = await this.#reads.snapshot();
    const record = state.capabilities.find(
      (candidate): candidate is LiveCapabilityRecord =>
        candidate.type === "live" &&
        candidate.providedAtOffset === input.providedAtOffset &&
        sameCapabilityPath(candidate.path, input.path),
    );
    if (record === undefined) return undefined;
    return this.#liveCapabilityLeases.activate(input, record);
  }

  async describeCapabilities(): Promise<CapabilityDescription[]> {
    await this.#reconcileLiveCapabilityLeases();
    return await this.#capabilityHostProcessor.describeCapabilities();
  }

  /** Internal hibernatable provider-lease upgrade; no ingress route addresses this DO. */
  fetch(request: Request): Response {
    return this.#liveCapabilityLeases.acceptUpgrade(request);
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Lifecycle frames are DO -> relay only.
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.#invalidateLiveLeaseReconciliation();
    await this.#reconcileLiveCapabilityLeases();
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    this.#liveCapabilityLeases.handleError(ws, error);
  }

  /**
   * Sweep records whose owner socket did not survive a deployment/restart.
   * Cloudflare terminates WebSockets during shutdown but does not promise the
   * dying incarnation enough time to journal every close callback. A fresh
   * incarnation can decide from durable bindings plus runtime-owned sockets,
   * so its first capability operation repairs that state in one exact event.
   */
  async #reconcileLiveCapabilityLeases(): Promise<void> {
    while (!this.#liveLeasesReconciled) {
      const active = this.#liveLeaseReconciliation;
      if (active !== undefined) {
        await active;
        continue;
      }
      const revision = this.#liveLeaseRevision;
      const reconciliation = this.#serializeMutation(async () => {
        await this.#registry.catchUp(CapabilityHostProcessorContract.slug);
        const { state } = await this.#reads.snapshot();
        const live = state.capabilities.filter(
          (record): record is LiveCapabilityRecord => record.type === "live",
        );
        const stale = live.filter(
          (record): record is LiveCapabilityRecord => !this.#liveCapabilityLeases.hasLease(record),
        );
        for (const record of stale) {
          await this.#capabilityHostProcessor.revokeCapability({
            path: record.path,
            providedAtOffset: record.providedAtOffset,
          });
          this.#liveCapabilityLeases.remove(record, { notifyRelay: false });
        }
        if (this.#liveLeaseRevision === revision) this.#liveLeasesReconciled = true;
      });
      this.#liveLeaseReconciliation = reconciliation;
      try {
        await reconciliation;
      } finally {
        if (this.#liveLeaseReconciliation === reconciliation) {
          this.#liveLeaseReconciliation = undefined;
        }
      }
    }
  }

  /** Invalidate any in-flight sweep whose socket view predates a close event. */
  #invalidateLiveLeaseReconciliation(): void {
    this.#liveLeaseRevision += 1;
    this.#liveLeasesReconciled = false;
  }

  /** Serialize this scope's low-volume capability control-plane mutations. */
  async #serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const predecessor = this.#capabilityMutationTail;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const tail = predecessor.then(() => gate);
    this.#capabilityMutationTail = tail;
    await predecessor;
    try {
      return await mutation();
    } finally {
      release();
      if (this.#capabilityMutationTail === tail) this.#capabilityMutationTail = Promise.resolve();
    }
  }
}
