import { DurableObject } from "cloudflare:workers";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import {
  checkCapabilityTypes,
  checkItxScriptForExecution,
  checkPreamble,
} from "../typecheck/virtual-project.ts";
import { sameCapabilityPath } from "./capability-path.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorReads,
} from "./capability-host-processor-implementation.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import type { ScriptExecutionSettlement } from "./script-execution-settlement.ts";
import {
  CapabilityProviderCallLegRpcTarget,
  CapabilityProviderPagers,
  type CapabilityProviderPagerActivation,
} from "./capability-provider-pager.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityRecord,
  RevokeCapabilityInput,
} from "./types.ts";

type ScriptExecutionEntrypoint = {
  run(
    code: string,
    options: { emittedJs?: string; expiresAt: number; preambleJs?: string },
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
  readonly #capabilityProviderPagers = new CapabilityProviderPagers({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  #capabilityMutationTail = Promise.resolve();
  #capabilityProviderPagerStartup: Promise<void> | undefined;
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
        this.#capabilityProviderPagers.invoke(record, path, args),
      scriptExecutionEntrypoint: this.#scriptExecutionEntrypoint(),
      validateCapabilityTypes: (types) =>
        checkCapabilityTypes({ types, typechecker: this.env.TYPECHECKER }),
      typecheckScript: (input) =>
        checkItxScriptForExecution({ ...input, typechecker: this.env.TYPECHECKER }),
      checkPreamble: (input) => checkPreamble({ ...input, typechecker: this.env.TYPECHECKER }),
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
    await this.#ensureCapabilityProviderPagersReconciled();
    return await this.#capabilityHostProcessor.invokeCapability(input);
  }

  async connectCapabilityProviderPager(input: { pagerDialId: string }): Promise<number> {
    await this.#ensureCapabilityProviderPagersReconciled();
    try {
      return await this.#serializeMutation(() =>
        this.#capabilityHostProcessor.connectCapabilityProviderPager({
          afterAppend: (connectedAtOffset) => {
            if (!this.#capabilityProviderPagers.connect(input.pagerDialId, connectedAtOffset)) {
              throw new Error("Capability Provider Pager disappeared while connecting");
            }
          },
        }),
      );
    } catch (error) {
      // The connected event may have committed before its opening Pager
      // vanished. Re-run the cold-start sweep to journal that exact drop.
      this.#capabilityProviderPagerStartup = undefined;
      this.ctx.waitUntil(this.#ensureCapabilityProviderPagersReconciled());
      throw error;
    }
  }

  async provideCapability(
    input: CapabilityProvidedPayload,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    await this.#ensureCapabilityProviderPagersReconciled();
    return await this.#serializeMutation(async () => {
      const { state } = await this.#reads.snapshot();
      if (input.type === "live") {
        const connectedAtOffset = input.providerPager.connectedAtOffset;
        if (
          !state.capabilityProviderPagers.some(
            (pager) => pager.connectedAtOffset === connectedAtOffset,
          ) ||
          !this.#capabilityProviderPagers.hasPager(connectedAtOffset)
        ) {
          throw new Error("live capability provision's Capability Provider Pager is disconnected");
        }
      }
      const replaced = state.capabilities.find((record) =>
        sameCapabilityPath(record.path, input.path),
      );
      return await this.#capabilityHostProcessor.provideCapability(input, {
        afterAppend: (record) => {
          // The append has already displaced this row. Retire its relay even
          // if binding the replacement fails; otherwise the old ownership
          // handle would remain active for a mount the table no longer holds.
          if (replaced?.type === "live") this.#capabilityProviderPagers.removeMount(replaced);
          if (input.type === "live") {
            if (record.type !== "live") {
              throw new Error("live capability provision committed a non-live record");
            }
            if (!this.#capabilityProviderPagers.hasPager(input.providerPager.connectedAtOffset)) {
              this.#capabilityProviderPagerStartup = undefined;
              this.ctx.waitUntil(this.#ensureCapabilityProviderPagersReconciled());
              throw new Error(
                `live capability "${input.path.join(".")}" Provider Pager disappeared`,
              );
            }
          }
        },
      });
    });
  }

  async revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    await this.#ensureCapabilityProviderPagersReconciled();
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
        this.#capabilityProviderPagers.removeMount(record);
      }
    });
  }

  async activateLiveCapability(
    input: CapabilityProviderPagerActivation,
  ): Promise<CapabilityProviderCallLegRpcTarget | undefined> {
    await this.#ensureCapabilityProviderPagersReconciled();
    const { state } = await this.#reads.snapshot();
    const record = state.capabilities.find(
      (candidate): candidate is Extract<CapabilityRecord, { type: "live" }> =>
        candidate.type === "live" && candidate.providedAtOffset === input.providedAtOffset,
    );
    if (record === undefined) return undefined;
    return this.#capabilityProviderPagers.activate(input, record);
  }

  async describeCapabilities(): Promise<CapabilityDescription[]> {
    await this.#ensureCapabilityProviderPagersReconciled();
    return await this.#capabilityHostProcessor.describeCapabilities();
  }

  /** Accept a client-given Capability Provider Pager; no ingress route addresses this DO. */
  fetch(request: Request): Response {
    return this.#capabilityProviderPagers.acceptUpgrade(request);
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Pages are DO -> relay only.
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const connectedAtOffset = this.#capabilityProviderPagers.connectedAtOffset(ws);
    if (connectedAtOffset === undefined) return;
    await this.#ensureCapabilityProviderPagersReconciled();
    await this.#disconnectCapabilityProviderPager(connectedAtOffset);
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    this.#capabilityProviderPagers.handleError(ws, error);
  }

  /**
   * Record each connected Pager whose physical WebSocket did not survive a
   * deployment/restart. One disconnected event atomically retires every live
   * mount that references the Pager's connected offset.
   * Cloudflare terminates WebSockets during shutdown but does not promise the
   * dying incarnation enough time to journal every close callback. A fresh
   * incarnation can decide from durable bindings plus runtime-owned sockets,
   * so its first capability operation repairs that state in one exact event.
   */
  async #ensureCapabilityProviderPagersReconciled(): Promise<void> {
    const active = this.#capabilityProviderPagerStartup;
    if (active !== undefined) return await active;
    const startup = this.#reconcileMissingCapabilityProviderPagers();
    this.#capabilityProviderPagerStartup = startup;
    try {
      await startup;
    } catch (error) {
      if (this.#capabilityProviderPagerStartup === startup)
        this.#capabilityProviderPagerStartup = undefined;
      throw error;
    }
  }

  async #reconcileMissingCapabilityProviderPagers(): Promise<void> {
    await this.#serializeMutation(async () => {
      await this.#registry.catchUp(CapabilityHostProcessorContract.slug);
      const { state } = await this.#reads.snapshot();
      for (const pager of state.capabilityProviderPagers) {
        if (this.#capabilityProviderPagers.hasPager(pager.connectedAtOffset)) continue;
        await this.#capabilityHostProcessor.disconnectCapabilityProviderPager(
          pager.connectedAtOffset,
        );
        this.#capabilityProviderPagers.removePager(pager.connectedAtOffset);
      }
    });
  }

  async #disconnectCapabilityProviderPager(connectedAtOffset: number): Promise<void> {
    await this.#serializeMutation(async () => {
      await this.#capabilityHostProcessor.disconnectCapabilityProviderPager(connectedAtOffset);
      this.#capabilityProviderPagers.removePager(connectedAtOffset);
    });
  }

  /** Serialize this scope's low-volume capability control-plane mutations. */
  #serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#capabilityMutationTail.then(mutation);
    this.#capabilityMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  setPreamble(input: { key: string; code: string }): Promise<void> {
    // Serialized like every capability mutation: the set-time compile
    // snapshots state, awaits an expensive check, then appends — two
    // concurrent sets validating against the same snapshot could each pass
    // in isolation and commit a combined preamble that no longer compiles.
    return this.#serializeMutation(() => this.#capabilityHostProcessor.setPreamble(input));
  }

  describePreamble(): Promise<{ text: string; entries: { key: string; code: string }[] } | null> {
    return this.#capabilityHostProcessor.describePreamble();
  }

  removePreamble(input: { key: string }): Promise<void> {
    return this.#serializeMutation(() => this.#capabilityHostProcessor.removePreamble(input));
  }

  getScriptResult(executionId: string): Promise<{ executionId: string; data: unknown }> {
    return this.#capabilityHostProcessor.getScriptResult(executionId);
  }
}
