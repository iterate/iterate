import { RpcTarget } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { openHibernatableRpcLeaseSocket } from "../hibernatable-rpc-lease.ts";
import { retainLiveCapabilityProvider, type LiveCapability } from "./live-capability.ts";
import {
  LIVE_CAPABILITY_LEASE_HEADER,
  parseLiveCapabilityLeaseFrame,
  type LiveCapabilityInvoker,
} from "./live-capability-lease.ts";
import type {
  CapabilityProvidedPayload,
  ProvideCapabilityInput,
  RevokeCapabilityInput,
} from "./types.ts";
import { assertCapabilityPath } from "./capability-path.ts";

export type LiveProvideInput = Extract<ProvideCapabilityInput, { type: "live" }>;

type LiveCapabilityRelayProvision = {
  isActive(): boolean;
  path: string[];
  providedAtOffset: number;
  revoke(input: RevokeCapabilityInput): Promise<void>;
};

type MountedProvision = { path: string[]; providedAtOffset: number };

type PendingRevocation = {
  input: RevokeCapabilityInput;
  reject(error: unknown): void;
  resolve(): void;
};

type PendingProvision = {
  entry: ProviderEntry;
  record: CapabilityProvidedPayload;
  reject(error: unknown): void;
  resolve(provision: MountedProvision): void;
};

type ProviderEntry = {
  activeLeg: Disposable | undefined;
  attachPhase: "idle" | "attaching" | "idle-pending";
  leaseKey: string;
  provision: MountedProvision | undefined;
  retired: "channel" | "host" | undefined;
  retainedProvider: LiveCapability;
  wakePending: boolean;
};

const MAX_PROVISION_BATCH_SIZE = 100;
const PROVISION_BATCH_WINDOW_MS = 5;

/** One short RPC leg from the relay's retained provider into the active DO. */
class LiveCapabilityInvokerRpcTarget extends RpcTarget implements LiveCapabilityInvoker {
  readonly #provider: LiveCapability;

  constructor(provider: LiveCapability) {
    super();
    this.#provider = provider;
  }

  invoke(path: string[], args: unknown[]): unknown {
    return this.#provider.invoke(path, args);
  }
}

/**
 * Own all providers for one stateless execution-context/CapabilityHost pair.
 *
 * Kenton's long-term design terminates Cap'n Web in an ordinary Worker and
 * uses Workers RPC only for short calls into a Durable Object. Future runtime
 * support would make outbound stubs recreatable through hibernation:
 * - https://github.com/cloudflare/capnweb/issues/36#issuecomment-3334955335
 * - https://github.com/cloudflare/capnweb/issues/36#issuecomment-4040638107
 *
 * Until then, this channel is that recreatable-stub directory. One
 * hibernatable WebSocket carries addressed wake/idle/retire frames for every
 * logical provider retained in this stateless context. On Workers Standard,
 * that leg is charged by requests and CPU time rather than DO GB-s duration:
 * https://developers.cloudflare.com/workers/platform/pricing/
 * https://developers.cloudflare.com/durable-objects/platform/pricing/
 * The CapabilityHost keeps no provider stub while idle, and provider
 * population does not multiply physical WebSockets or entrypoint contexts.
 */
export class LiveCapabilityProviderChannel {
  readonly #channelKey = crypto.randomUUID();
  readonly #durableObject: ReturnType<Env["CAPABILITY_HOST"]["getByName"]>;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #pendingProvisions: PendingProvision[] = [];
  readonly #providers = new Map<string, ProviderEntry>();
  readonly #pendingRevocations: PendingRevocation[] = [];
  #opening: Promise<{ socket: WebSocket; socketId: string }> | undefined;
  #socket: { socket: WebSocket; socketId: string } | undefined;
  #terminal = false;
  #provisionFlush: ReturnType<typeof setTimeout> | undefined;
  #revocationFlush: ReturnType<typeof setTimeout> | undefined;

  constructor(input: {
    env: Env;
    scope: { path: string; projectId: string };
    waitUntil(promise: Promise<unknown>): void;
  }) {
    const path = normalizePath(input.scope.path);
    this.#durableObject = input.env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({ path, projectId: input.scope.projectId }),
    );
    this.#waitUntil = input.waitUntil;
  }

  /** False after the shared channel broke or its last logical lease retired. */
  get acceptsProviders(): boolean {
    return !this.#terminal;
  }

  async provide(input: LiveProvideInput): Promise<LiveCapabilityRelayProvision> {
    if (this.#terminal) throw new Error("live capability provider channel is closed");
    // Reject an invalid provider before opportunistic batching. Otherwise one
    // malformed mount could make the DO reject up to 99 unrelated siblings in
    // the same five-millisecond flush window.
    assertCapabilityPath(input.path);
    if (!Object.hasOwn(input, "capability")) {
      throw new Error('live capabilities require "capability"');
    }

    const entry: ProviderEntry = {
      activeLeg: undefined,
      attachPhase: "idle",
      leaseKey: crypto.randomUUID(),
      provision: undefined,
      retired: undefined,
      retainedProvider: retainLiveCapabilityProvider(input.capability, {
        flattenNestedPath: input.flattenNestedPaths === true,
      }),
      wakePending: false,
    };
    this.#providers.set(entry.leaseKey, entry);

    let channel: { socket: WebSocket; socketId: string };
    try {
      channel = await this.#openChannel();
    } catch (error) {
      this.#retire(entry, "channel");
      throw error;
    }

    const record: CapabilityProvidedPayload = {
      flattenNestedPaths: input.flattenNestedPaths === true ? true : undefined,
      instructions: input.instructions,
      path: input.path,
      providerBinding: {
        channelKey: this.#channelKey,
        leaseKey: entry.leaseKey,
        socketId: channel.socketId,
      },
      type: "live",
      types: input.types,
    };
    try {
      // Untyped live mounts have no per-item network-bound validation, so
      // simultaneous exports can share one stream append and one project-
      // worker delivery. Typed mounts retain the isolated command boundary:
      // one bad authored declaration must not poison unrelated providers in
      // the same opportunistic batch.
      const mounted =
        input.types === undefined
          ? await this.#queueProvision(entry, record, channel)
          : await this.#durableObject.provideCapability(record, {
              leaseKey: this.#channelKey,
              socketId: channel.socketId,
            });
      entry.provision = mounted;
      // A call can observe the committed record and issue wake before the
      // provide RPC returns. Replay that latched edge once its durable offset
      // is known.
      this.#attachPendingProvider(entry);
      if (entry.retired !== undefined) {
        // An addressed retire means the durable table already superseded or
        // revoked this exact mount. The provide command still succeeded and
        // returns its normal, already-inactive ownership handle. Physical
        // channel loss is different: its possibly committed record must be
        // exact-rolled back and the command must reject.
        if (entry.retired === "host") return this.#provisionHandle(entry, mounted);
        await this.#durableObject.revokeCapability(entry.provision);
        throw new Error(`live capability "${input.path.join(".")}" channel closed while mounting`);
      }
      return this.#provisionHandle(entry, mounted);
    } catch (error) {
      this.#retire(entry, "channel");
      throw error;
    }
  }

  #provisionHandle(entry: ProviderEntry, mounted: MountedProvision): LiveCapabilityRelayProvision {
    return {
      isActive: () => entry.retired === undefined && !this.#terminal,
      path: mounted.path,
      providedAtOffset: mounted.providedAtOffset,
      revoke: async (revokeInput) => {
        try {
          await this.#queueRevocation(revokeInput);
        } finally {
          this.#retire(entry, "host");
        }
      },
    };
  }

  #queueProvision(
    entry: ProviderEntry,
    record: CapabilityProvidedPayload,
    channel: { socketId: string },
  ): Promise<MountedProvision> {
    if (this.#terminal || entry.retired !== undefined) {
      return Promise.reject(new Error("live capability provider channel is closed"));
    }
    const result = new Promise<MountedProvision>((resolve, reject) => {
      this.#pendingProvisions.push({ entry, record, reject, resolve });
    });
    this.#scheduleProvisionFlush(channel.socketId, PROVISION_BATCH_WINDOW_MS);
    return result;
  }

  #scheduleProvisionFlush(socketId: string, delayMs: number): void {
    if (this.#provisionFlush !== undefined) return;
    this.#provisionFlush = setTimeout(() => {
      this.#provisionFlush = undefined;
      void this.#flushProvisions(socketId);
    }, delayMs);
  }

  async #flushProvisions(socketId: string): Promise<void> {
    const candidates = this.#pendingProvisions.splice(0, MAX_PROVISION_BATCH_SIZE);
    const batch: PendingProvision[] = [];
    for (const pending of candidates) {
      if (this.#terminal || pending.entry.retired !== undefined) {
        pending.reject(new Error("live capability provider channel closed while mounting"));
      } else {
        batch.push(pending);
      }
    }
    if (batch.length > 0) {
      try {
        const provisions = await this.#durableObject.provideCapabilities(
          batch.map(({ record }) => record),
          { leaseKey: this.#channelKey, socketId },
        );
        if (provisions.length !== batch.length) {
          throw new Error(
            `live capability batch returned ${provisions.length} provisions for ${batch.length} providers`,
          );
        }
        for (const [index, pending] of batch.entries()) {
          const provision = provisions[index];
          if (provision === undefined) {
            pending.reject(new Error(`live capability batch lost provision ${index}`));
          } else {
            pending.resolve(provision);
          }
        }
      } catch (error) {
        for (const pending of batch) pending.reject(error);
      }
    }
    if (this.#pendingProvisions.length > 0) {
      this.#scheduleProvisionFlush(socketId, 0);
    }
  }

  /**
   * Coalesce simultaneous ownership-handle disposal into one DO turn and one
   * table-reduction event. Without this boundary, disposing a thousand
   * session exports creates a thousand concurrent snapshots and O(n²) state
   * copies precisely when the provider session is already under pressure.
   */
  #queueRevocation(input: RevokeCapabilityInput): Promise<void> {
    if (input.providedAtOffset === undefined) {
      throw new Error("live provider revocation requires an exact providedAtOffset");
    }
    const result = new Promise<void>((resolve, reject) => {
      this.#pendingRevocations.push({ input, reject, resolve });
    });
    if (this.#revocationFlush === undefined) {
      this.#revocationFlush = setTimeout(() => {
        this.#revocationFlush = undefined;
        void this.#flushRevocations();
      }, 5);
    }
    return result;
  }

  async #flushRevocations(): Promise<void> {
    const batch = this.#pendingRevocations.splice(0);
    if (batch.length === 0) return;
    try {
      await this.#durableObject.revokeCapabilities(batch.map(({ input }) => input));
      for (const pending of batch) pending.resolve();
    } catch (error) {
      for (const pending of batch) pending.reject(error);
    }
  }

  async #openChannel(): Promise<{ socket: WebSocket; socketId: string }> {
    if (this.#socket !== undefined) return this.#socket;
    if (this.#opening !== undefined) return await this.#opening;
    const socketId = crypto.randomUUID();
    const opening = (async () => {
      const socket = await openHibernatableRpcLeaseSocket({
        headerName: LIVE_CAPABILITY_LEASE_HEADER,
        headerValue: { channelKey: this.#channelKey, socketId },
        stub: this.#durableObject,
        url: "https://live-capability-lease.internal/",
      });
      const channel = { socket, socketId };
      if (this.#terminal) {
        socket.close(1000, "provider channel closed while opening");
        throw new Error("live capability provider channel closed while opening");
      }
      this.#socket = channel;
      socket.addEventListener("message", (event) => this.#handleFrame(event.data));
      socket.addEventListener("close", () => {
        if (this.#socket?.socket !== socket) return;
        this.#socket = undefined;
        this.#failChannel("lease socket closed");
      });
      socket.addEventListener("error", () => this.#failChannel("lease socket error"));
      return channel;
    })();
    this.#opening = opening;
    try {
      return await opening;
    } finally {
      if (this.#opening === opening) this.#opening = undefined;
    }
  }

  #handleFrame(data: unknown): void {
    if (this.#terminal) return;
    const frame = parseLiveCapabilityLeaseFrame(data);
    if (frame === undefined) return;
    const entry = this.#providers.get(frame.leaseKey);
    if (entry === undefined || entry.retired !== undefined) return;
    if (frame.type === "wake") {
      entry.wakePending = true;
      this.#attachPendingProvider(entry);
    } else if (frame.type === "idle") {
      if (entry.attachPhase !== "idle") {
        entry.attachPhase = "idle-pending";
      } else {
        this.#releaseActiveLeg(entry);
      }
    } else {
      this.#retire(entry, "host");
    }
  }

  #attachPendingProvider(entry: ProviderEntry): void {
    if (entry.retired !== undefined || entry.attachPhase !== "idle" || !entry.wakePending) return;
    const provision = entry.provision;
    const channel = this.#socket;
    if (provision === undefined || channel === undefined) return;
    entry.wakePending = false;
    entry.attachPhase = "attaching";
    const attachment = (async () => {
      try {
        const activatedLeg = await this.#durableObject.activateLiveCapability({
          channelKey: this.#channelKey,
          invoker: new LiveCapabilityInvokerRpcTarget(entry.retainedProvider),
          leaseKey: entry.leaseKey,
          path: provision.path,
          providedAtOffset: provision.providedAtOffset,
          socketId: channel.socketId,
        });
        // A timed-out or superseded wake may be refused after the relay has
        // moved on. It does not damage sibling leases on this channel.
        if (activatedLeg !== undefined) {
          this.#releaseActiveLeg(entry);
          if (entry.retired === undefined && entry.attachPhase === "attaching") {
            entry.activeLeg = activatedLeg;
          } else {
            activatedLeg[Symbol.dispose]();
          }
        } else if (entry.attachPhase === "idle-pending") {
          // A timed-out wake can be retried before its slow attach returns.
          // The first attach may satisfy the retry and go idle while the
          // relay is issuing a now-refused second attach. Preserve that idle
          // edge: otherwise its previously returned leg remains retained and
          // pins the DO even though the DO has no active provider.
          this.#releaseActiveLeg(entry);
        }
      } catch (error) {
        console.error("live capability provider attach failed; ending provision", {
          error,
          path: provision.path,
          providedAtOffset: provision.providedAtOffset,
        });
        this.#retire(entry, "channel");
        try {
          await this.#durableObject.revokeCapability(provision);
        } catch (revokeError) {
          // A provider we have deliberately released cannot retain a healthy-
          // looking durable row. Closing the shared epoch makes the DO's exact
          // close reconciliation own every sibling as well; rejecting this
          // waitUntil task preserves the durable explanation in telemetry.
          this.#failChannel("provider attach rollback failed");
          throw new AggregateError(
            [error, revokeError],
            `live capability "${provision.path.join(".")}" attach and rollback failed`,
          );
        }
      } finally {
        entry.attachPhase = "idle";
        this.#attachPendingProvider(entry);
      }
    })();
    this.#waitUntil(attachment);
  }

  #releaseActiveLeg(entry: ProviderEntry): void {
    const releasing = entry.activeLeg;
    if (releasing === undefined) return;
    entry.activeLeg = undefined;
    try {
      releasing[Symbol.dispose]();
    } catch (error) {
      console.error("live capability provider leg disposal failed", { error });
    }
  }

  #retire(entry: ProviderEntry, reason: "channel" | "host"): void {
    if (entry.retired !== undefined) return;
    entry.retired = reason;
    this.#providers.delete(entry.leaseKey);
    this.#releaseActiveLeg(entry);
    try {
      entry.retainedProvider.dispose();
    } catch (error) {
      console.error("live capability retained provider disposal failed", { error });
    }
    if (this.#providers.size > 0 || this.#terminal) return;
    this.#terminal = true;
    try {
      this.#socket?.socket.close(1000, "provider channel empty");
    } catch {
      // Already closing.
    }
  }

  #failChannel(reason: string): void {
    if (this.#terminal) return;
    this.#terminal = true;
    const entries = [...this.#providers.values()];
    for (const entry of entries) this.#retire(entry, "channel");
    try {
      this.#socket?.socket.close(1011, reason);
    } catch {
      // Already closing.
    }
  }
}
