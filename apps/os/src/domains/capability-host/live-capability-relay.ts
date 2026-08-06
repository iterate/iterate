import { RpcTarget } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import {
  openHibernatableRpcLeaseSocket,
  parseHibernatableRpcLeaseFrame,
} from "../hibernatable-rpc-lease.ts";
import { assertCapabilityPath } from "./capability-path.ts";
import { retainLiveCapabilityProvider, type LiveCapability } from "./live-capability.ts";
import {
  LIVE_CAPABILITY_LEASE_HEADER,
  LIVE_CAPABILITY_RETIRED_CLOSE_CODE,
  type LiveCapabilityInvoker,
} from "./live-capability-lease.ts";
import type {
  CapabilityProvidedPayload,
  ProvideCapabilityInput,
  RevokeCapabilityInput,
} from "./types.ts";

export type LiveProvideInput = Extract<ProvideCapabilityInput, { type: "live" }>;

type LiveCapabilityRelayProvision = {
  isActive(): boolean;
  path: string[];
  providedAtOffset: number;
  revoke(input: RevokeCapabilityInput): Promise<void>;
};

type MountedProvision = { path: string[]; providedAtOffset: number };

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
 * Stateless owner of one live provider and its one hibernatable DO socket.
 *
 * The provider remains in this stateless context. The DO wakes a short
 * Workers RPC leg only while it has calls to make, then releases that leg so
 * the Durable Object can hibernate without pinning the provider stub.
 */
export class LiveCapabilityProviderRelay {
  readonly #durableObject: ReturnType<Env["CAPABILITY_HOST"]["getByName"]>;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #mounted = Promise.withResolvers<MountedProvision>();
  #activeLeg: Disposable | undefined;
  #frameTail = Promise.resolve();
  #provided = false;
  #provision: MountedProvision | undefined;
  #retainedProvider: LiveCapability | undefined;
  #retired: "host" | "transport" | undefined;
  #socket: WebSocket | undefined;
  #socketId: string | undefined;

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
    void this.#mounted.promise.catch(() => undefined);
  }

  async provide(input: LiveProvideInput): Promise<LiveCapabilityRelayProvision> {
    if (this.#provided) throw new Error("live capability relay can mount only one provider");
    this.#provided = true;
    assertCapabilityPath(input.path);
    if (!Object.hasOwn(input, "capability")) {
      throw new Error('live capabilities require "capability"');
    }

    this.#retainedProvider = retainLiveCapabilityProvider(input.capability, {
      flattenNestedPath: input.flattenNestedPaths === true,
    });
    const socketId = crypto.randomUUID();
    this.#socketId = socketId;

    try {
      const socket = await openHibernatableRpcLeaseSocket({
        headerName: LIVE_CAPABILITY_LEASE_HEADER,
        headerValue: { socketId },
        stub: this.#durableObject,
        url: "https://live-capability-lease.internal/",
      });
      this.#socket = socket;
      socket.addEventListener("message", (event) => this.#enqueueFrame(event.data));
      socket.addEventListener("close", (event) => {
        this.#retire(event.code === LIVE_CAPABILITY_RETIRED_CLOSE_CODE ? "host" : "transport");
      });
      socket.addEventListener("error", () => this.#retire("transport"));

      const record: CapabilityProvidedPayload = {
        flattenNestedPaths: input.flattenNestedPaths === true ? true : undefined,
        instructions: input.instructions,
        path: input.path,
        providerBinding: { socketId },
        type: "live",
        types: input.types,
      };
      const provision = await this.#durableObject.provideCapability(record, { socketId });
      this.#provision = provision;
      this.#mounted.resolve(provision);

      if (this.#retired === "transport") {
        await this.#durableObject.revokeCapability(provision);
        throw new Error(`live capability "${input.path.join(".")}" socket closed while mounting`);
      }
      return this.#provisionHandle(provision);
    } catch (error) {
      this.#mounted.reject(error);
      this.#retire("transport");
      throw error;
    }
  }

  #provisionHandle(provision: MountedProvision): LiveCapabilityRelayProvision {
    return {
      isActive: () => this.#retired === undefined,
      path: provision.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: async (input) => {
        try {
          await this.#durableObject.revokeCapability(input);
        } finally {
          this.#retire("host");
        }
      },
    };
  }

  #enqueueFrame(data: unknown): void {
    const frame = parseHibernatableRpcLeaseFrame(data);
    if (frame === undefined || this.#retired !== undefined) return;
    const task = this.#frameTail.then(async () => {
      if (this.#retired !== undefined) return;
      if (frame.type === "wake") await this.#activateProvider();
      else this.#releaseActiveLeg();
    });
    this.#frameTail = task.catch(() => undefined);
    this.#waitUntil(
      task.catch(async (error) => {
        await this.#failActivation(error);
      }),
    );
  }

  async #activateProvider(): Promise<void> {
    const provision = await this.#mounted.promise;
    const provider = this.#retainedProvider;
    const socketId = this.#socketId;
    if (this.#retired !== undefined) return;
    if (provider === undefined || socketId === undefined) {
      throw new Error("live capability relay lost its mounted provider");
    }
    const activeLeg = await this.#durableObject.activateLiveCapability({
      invoker: new LiveCapabilityInvokerRpcTarget(provider),
      path: provision.path,
      providedAtOffset: provision.providedAtOffset,
      socketId,
    });
    // The DO returns no leg when this wake lost its pending-attach race. A
    // later wake may already be waiting, so this is stale work, not a failed
    // provider transport.
    if (activeLeg === undefined) return;
    this.#releaseActiveLeg();
    if (this.#retired === undefined) this.#activeLeg = activeLeg;
    else activeLeg[Symbol.dispose]();
  }

  async #failActivation(error: unknown): Promise<never> {
    const provision = this.#provision;
    this.#retire("transport");
    if (provision === undefined) throw error;
    try {
      await this.#durableObject.revokeCapability(provision);
    } catch (revokeError) {
      throw new AggregateError(
        [error, revokeError],
        `live capability "${provision.path.join(".")}" activation and rollback failed`,
      );
    }
    throw error;
  }

  #releaseActiveLeg(): void {
    const activeLeg = this.#activeLeg;
    if (activeLeg === undefined) return;
    this.#activeLeg = undefined;
    try {
      activeLeg[Symbol.dispose]();
    } catch (error) {
      console.error("live capability provider leg disposal failed", { error });
    }
  }

  #retire(reason: "host" | "transport"): void {
    if (this.#retired !== undefined) return;
    this.#retired = reason;
    this.#releaseActiveLeg();
    try {
      this.#retainedProvider?.dispose();
    } catch (error) {
      console.error("live capability retained provider disposal failed", { error });
    }
    try {
      this.#socket?.close(
        reason === "host" ? 1000 : 1011,
        reason === "host" ? "live capability retired" : "live capability relay failed",
      );
    } catch {
      // Already closing.
    }
  }
}
