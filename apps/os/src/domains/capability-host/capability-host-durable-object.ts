import { DurableObject } from "cloudflare:workers";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { HibernatableRpcLeaseBinding } from "../hibernatable-rpc-lease.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { checkCapabilityTypes, checkItxScriptForExecution } from "../typecheck/virtual-project.ts";
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
  readonly #capabilityMutationTails = new Map<string, Promise<void>>();
  readonly #liveChannelMutationTails = new Map<string, Promise<void>>();
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
    liveLease?: HibernatableRpcLeaseBinding,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    await this.#reconcileLiveCapabilityLeases();
    if (input.type === "live" && liveLease === undefined) {
      throw new Error("live capability provision requires a hibernatable provider lease");
    }
    const provide = () =>
      this.#serializeMutations(
        this.#capabilityMutationTails,
        [JSON.stringify(input.path)],
        async () => {
          const { state } = await this.#reads.snapshot();
          const replaced = state.capabilities.find(
            (record) =>
              record.path.length === input.path.length &&
              record.path.every((segment, index) => segment === input.path[index]),
          );
          return await this.#capabilityHostProcessor.provideCapability(input, {
            afterCommit: ({ record }, settlement) => {
              // The append has already replaced this row. Retire its relay
              // owner even if binding the new row fails and rollback leaves
              // the path empty; otherwise the old handle stays active with no
              // durable record. Keep the local retirement guard until either
              // the replacement or its rollback is readable.
              if (replaced?.type === "live") {
                settlement.retain(this.#liveCapabilityLeases.remove(replaced));
              }
              if (input.type === "live") {
                if (liveLease === undefined) {
                  throw new Error("live capability provision lost its validated provider lease");
                }
                if (record.type !== "live") {
                  throw new Error("live capability provision committed a non-live record");
                }
                if (!this.#liveCapabilityLeases.bindProvision(record, liveLease)) {
                  throw new Error(
                    `live capability "${input.path.join(".")}" lease socket disappeared`,
                  );
                }
              }
            },
          });
        },
      );
    return input.type === "live" && liveLease !== undefined
      ? await this.#serializeMutations(
          this.#liveChannelMutationTails,
          [liveLease.leaseKey],
          provide,
        )
      : await provide();
  }

  /**
   * Mount one relay-channel burst in one stream append while retaining a
   * distinct durable offset and ownership handle for every logical provider.
   */
  async provideCapabilities(
    inputs: CapabilityProvidedPayload[],
    liveLease: HibernatableRpcLeaseBinding,
  ): Promise<{ path: string[]; providedAtOffset: number }[]> {
    if (inputs.length === 0) return [];
    await this.#reconcileLiveCapabilityLeases();
    for (const input of inputs) {
      if (input.type !== "live") {
        throw new Error("live provider batch contains a non-live capability");
      }
      if (
        input.providerBinding?.channelKey !== liveLease.leaseKey ||
        input.providerBinding.socketId !== liveLease.socketId
      ) {
        throw new Error("live provider batch does not belong to its hibernatable channel");
      }
    }
    return await this.#serializeMutations(
      this.#liveChannelMutationTails,
      [liveLease.leaseKey],
      () =>
        this.#serializeMutations(
          this.#capabilityMutationTails,
          inputs.map(({ path }) => JSON.stringify(path)),
          async () => {
            const { state } = await this.#reads.snapshot();
            const winnerByPath = new Map<string, CapabilityRecord>();
            for (const record of state.capabilities) {
              winnerByPath.set(JSON.stringify(record.path), record);
            }
            return await this.#capabilityHostProcessor.provideCapabilities(inputs, {
              afterCommit: ({ mounts }, settlement) => {
                // The append has already replaced every prior row and only the
                // last duplicate path in this batch can win. Retire all of
                // those displaced relay owners before binding winners, and
                // retain their local guards through either readable outcome.
                for (const { record } of mounts) {
                  const key = JSON.stringify(record.path);
                  const replaced = winnerByPath.get(key);
                  if (replaced?.type === "live") {
                    settlement.retain(this.#liveCapabilityLeases.remove(replaced));
                  }
                  winnerByPath.set(key, record);
                }
                for (const { record } of mounts) {
                  if (winnerByPath.get(JSON.stringify(record.path)) !== record) continue;
                  if (record.type !== "live") {
                    throw new Error("live capability batch committed a non-live record");
                  }
                  if (!this.#liveCapabilityLeases.bindProvision(record, liveLease)) {
                    throw new Error(
                      `live capability "${record.path.join(".")}" lease socket disappeared`,
                    );
                  }
                }
              },
            });
          },
        ),
    );
  }

  async revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    await this.#reconcileLiveCapabilityLeases();
    await this.#serializeMutations(
      this.#capabilityMutationTails,
      [JSON.stringify(input.path)],
      async () => {
        const { state } = await this.#reads.snapshot();
        const record = state.capabilities.find(
          (candidate) =>
            candidate.path.length === input.path.length &&
            candidate.path.every((segment, index) => segment === input.path[index]),
        );
        await this.#capabilityHostProcessor.revokeCapability(input);
        if (
          record?.type === "live" &&
          (input.providedAtOffset === undefined ||
            input.providedAtOffset === record.providedAtOffset)
        ) {
          this.#liveCapabilityLeases.remove(record)[Symbol.dispose]();
        }
      },
    );
  }

  /** Revoke a burst of exact mounts with one durable table-reduction event. */
  async revokeCapabilities(inputs: RevokeCapabilityInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.#reconcileLiveCapabilityLeases();
    const exact = new Set<string>();
    for (const input of inputs) {
      if (input.providedAtOffset === undefined) {
        throw new Error("batched capability revocation requires exact providedAtOffset values");
      }
      exact.add(exactMountKey(input.path, input.providedAtOffset));
    }

    const { state } = await this.#reads.snapshot();
    const current = state.capabilities.filter((record) =>
      exact.has(exactMountKey(record.path, record.providedAtOffset)),
    );
    if (current.length === 0) return;
    await this.#capabilityHostProcessor.revokeCapabilities(
      current.map((record) => ({
        path: record.path,
        providedAtOffset: record.providedAtOffset,
      })),
    );
    for (const record of current) {
      if (record.type === "live") this.#liveCapabilityLeases.remove(record)[Symbol.dispose]();
    }
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
        candidate.path.length === input.path.length &&
        candidate.path.every((segment, index) => segment === input.path[index]),
    );
    if (record === undefined) return undefined;
    try {
      return this.#liveCapabilityLeases.activate(input, record);
    } catch (error) {
      // The DO owns activation admission, so it also owns making a rejected
      // provider durably disappear. The relay repeats this exact revocation
      // for transport-ambiguous failures; providedAtOffset makes it idempotent.
      const retirement = this.#liveCapabilityLeases.remove(record);
      try {
        await this.#serializeMutations(
          this.#capabilityMutationTails,
          [JSON.stringify(record.path)],
          () =>
            this.#capabilityHostProcessor.revokeCapability({
              path: record.path,
              providedAtOffset: record.providedAtOffset,
            }),
        );
        retirement[Symbol.dispose]();
      } catch (rollbackError) {
        this.#invalidateLiveLeaseReconciliation();
        throw new AggregateError(
          [error, rollbackError],
          `live capability "${record.path.join(".")}" activation and rollback failed`,
        );
      }
      throw error;
    }
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
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const departed = this.#liveCapabilityLeases.departedOnClose(ws);
    if (departed === undefined) {
      // Every accepted socket on this DO belongs to this lane. If its
      // attachment cannot be decoded, exact ownership is unknowable; a full
      // reconciliation is the bounded safe response, not a silent orphan.
      this.#invalidateLiveLeaseReconciliation();
      await this.#reconcileLiveCapabilityLeases();
      return;
    }
    this.#invalidateLiveLeaseReconciliation();
    // A provide commits its event before binding the channel and waiting for
    // processor ingestion. If close snapshots during that interval it would
    // miss the just-committed mount and leave an offline durable row behind.
    // Drain every provide already admitted for this channel, then catch up to
    // include any direct stream facts before deciding what departure owns.
    try {
      await (this.#liveChannelMutationTails.get(departed.channelKey) ?? Promise.resolve());
      await this.#registry.catchUp(CapabilityHostProcessorContract.slug);
      const { state } = await this.#reads.snapshot();
      const records = state.capabilities.filter(
        (record): record is LiveCapabilityRecord =>
          record.type === "live" &&
          record.providerBinding?.channelKey === departed.channelKey &&
          record.providerBinding.socketId === departed.socketId,
      );
      const retirements = records.map((record) =>
        this.#liveCapabilityLeases.remove(record, { notifyRelay: false }),
      );
      await this.#capabilityHostProcessor.revokeCapabilities(
        records.map((record) => ({
          path: record.path,
          providedAtOffset: record.providedAtOffset,
        })),
      );
      for (const retirement of retirements) retirement[Symbol.dispose]();
      this.#liveCapabilityLeases.settleDeparture(departed);
    } catch (error) {
      // A failed close callback must not become the warm incarnation's final
      // answer. Invalidate again in case a concurrent sweep completed after
      // the first invalidation; the next visible operation retries from the
      // durable table and exact runtime socket epochs.
      this.#invalidateLiveLeaseReconciliation();
      throw error;
    }
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
   * Pre-channel live records are swept by the same migration boundary.
   */
  async #reconcileLiveCapabilityLeases(): Promise<void> {
    while (!this.#liveLeasesReconciled) {
      const active = this.#liveLeaseReconciliation;
      if (active !== undefined) {
        await active;
        continue;
      }
      const revision = this.#liveLeaseRevision;
      const reconciliation = (async () => {
        await this.#registry.catchUp(CapabilityHostProcessorContract.slug);
        const { state } = await this.#reads.snapshot();
        const live = state.capabilities.filter(
          (record): record is LiveCapabilityRecord => record.type === "live",
        );
        const stale = live.filter(
          (record): record is LiveCapabilityRecord => !this.#liveCapabilityLeases.hasLease(record),
        );
        if (stale.length > 0) {
          await this.#capabilityHostProcessor.revokeCapabilities(
            stale.map((record) => ({
              path: record.path,
              providedAtOffset: record.providedAtOffset,
            })),
          );
          for (const record of stale) {
            this.#liveCapabilityLeases.remove(record, { notifyRelay: false })[Symbol.dispose]();
          }
        }
        const staleKeys = new Set(
          stale.map((record) => exactMountKey(record.path, record.providedAtOffset)),
        );
        this.#liveCapabilityLeases.settleDurableState(
          live.filter(
            (record) => !staleKeys.has(exactMountKey(record.path, record.providedAtOffset)),
          ),
        );
        if (this.#liveLeaseRevision === revision) this.#liveLeasesReconciled = true;
      })();
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

  /**
   * Serialize overlapping keys inside either mutation domain. Path gates keep
   * commit, transport binding, and read-your-writes in one order; channel
   * gates keep close cleanup behind every admitted provide for that socket.
   */
  async #serializeMutations<T>(
    tails: Map<string, Promise<void>>,
    inputKeys: string[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(inputKeys)].sort();
    const predecessors = keys.map((key) => tails.get(key) ?? Promise.resolve());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = Promise.all(predecessors).then(() => gate);
    for (const key of keys) tails.set(key, tail);
    await Promise.all(predecessors);
    try {
      return await mutation();
    } finally {
      release();
      for (const key of keys) {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    }
  }
}

function exactMountKey(path: string[], providedAtOffset: number): string {
  return JSON.stringify([path, providedAtOffset]);
}
