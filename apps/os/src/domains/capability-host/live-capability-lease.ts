import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { HibernatableRpcLeaseSockets } from "../hibernatable-rpc-lease.ts";
import type { CapabilityRecord } from "./types.ts";
import { deepRetainRpcStubs } from "./live-capability.ts";

type LiveCapabilityRecord = Extract<CapabilityRecord, { type: "live" }>;

/** Internal upgrade marker; no external ingress route addresses a CapabilityHost DO. */
export const LIVE_CAPABILITY_LEASE_HEADER = "x-iterate-live-capability-lease";

/** The host closed a healthy socket because its exact durable mount retired. */
export const LIVE_CAPABILITY_RETIRED_CLOSE_CODE = 4000;

const LIVE_CAPABILITY_LEASE_TAG = "live-capability-lease";
const PROVIDER_ATTACH_TIMEOUT_MS = 10_000;

const LiveCapabilityLeaseUpgrade = z
  .object({ socketId: z.string().trim().min(1) })
  .strict()
  .transform(({ socketId }) => ({ leaseKey: socketId, socketId }));

const LiveCapabilityLeaseAttachment = z
  .object({
    socketId: z.string().min(1),
  })
  .strict();

type LiveCapabilityLeaseAttachment = z.infer<typeof LiveCapabilityLeaseAttachment>;

export type LiveCapabilityLeaseActivation = {
  invoker: unknown;
  path: string[];
  providedAtOffset: number;
  socketId: string;
};

export type LiveCapabilityInvoker = {
  invoke(path: string[], args: unknown[]): unknown;
};

/** Retaining this short RPC leg keeps the provider reachable during one invocation burst. */
export class LiveCapabilityLegRpcTarget extends RpcTarget {}

type ActiveProvider = {
  invoker: LiveCapabilityInvoker & Disposable;
  inFlight: number;
  record: LiveCapabilityRecord;
};

type PendingProvider = {
  promise: Promise<void>;
  reject(error: Error): void;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
};

type LiveCapabilityLeaseHooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

/**
 * Durable-Object half of a live provider lease.
 *
 * Every durable live mount owns one hibernatable socket. The DO retains no
 * provider RPC stub while idle: it asks the relay for a short-lived leg on
 * demand and releases that leg when the concurrent invocation burst drains.
 */
export class LiveCapabilityLeaseServer {
  readonly #leases: HibernatableRpcLeaseSockets<LiveCapabilityLeaseAttachment>;
  readonly #activeProviders = new Map<string, ActiveProvider>();
  readonly #pendingProviders = new Map<string, PendingProvider>();

  constructor(hooks: LiveCapabilityLeaseHooks) {
    this.#leases = new HibernatableRpcLeaseSockets({
      attachmentSchema: LiveCapabilityLeaseAttachment,
      bindingOf: ({ socketId }) => ({ leaseKey: socketId, socketId }),
      createAttachment: ({ socketId }) => ({ socketId }),
      headerName: LIVE_CAPABILITY_LEASE_HEADER,
      hooks,
      lane: "live capability",
      socketTag: LIVE_CAPABILITY_LEASE_TAG,
      upgradeSchema: LiveCapabilityLeaseUpgrade,
    });
  }

  acceptUpgrade(request: Request): Response {
    return this.#leases.acceptUpgrade(request);
  }

  /** Bind a committed provision to its already-accepted socket. */
  bindProvision(record: LiveCapabilityRecord, socketId: string): boolean {
    return (
      record.providerBinding.socketId === socketId &&
      this.#leases.claim({ leaseKey: socketId, socketId }) !== undefined
    );
  }

  /** True when a durable record still has its exact hibernatable owner socket. */
  hasLease(record: LiveCapabilityRecord): boolean {
    return this.#entryFor(record) !== undefined;
  }

  /** Adopt one short provider leg after a wake request. */
  activate(
    input: LiveCapabilityLeaseActivation,
    record: LiveCapabilityRecord,
  ): LiveCapabilityLegRpcTarget | undefined {
    const key = record.providerBinding.socketId;
    const pending = this.#pendingProviders.get(key);
    if (
      pending === undefined ||
      input.socketId !== record.providerBinding.socketId ||
      this.#entryFor(record) === undefined
    ) {
      return undefined;
    }

    const retainedInvoker = deepRetainRpcStubs(input.invoker);
    const invoker = retainedInvoker.value;
    if (!isLiveCapabilityInvoker(invoker)) {
      retainedInvoker.dispose();
      const error = new Error("live capability attach requires an invoker RPC target");
      this.#failPending(key, error);
      throw error;
    }

    const activeInvoker: LiveCapabilityInvoker & Disposable = {
      invoke: (path, args) => invoker.invoke(path, args),
      [Symbol.dispose]: () => retainedInvoker.dispose(),
    };
    const active = { invoker: activeInvoker, inFlight: 0, record };
    try {
      const previous = this.#activeProviders.get(key);
      this.#activeProviders.set(key, active);
      previous?.invoker[Symbol.dispose]();
      clearTimeout(pending.timer);
      this.#pendingProviders.delete(key);
      pending.resolve();
      return new LiveCapabilityLegRpcTarget();
    } catch (error) {
      if (this.#activeProviders.get(key) === active) this.#activeProviders.delete(key);
      activeInvoker[Symbol.dispose]();
      this.#failPending(key, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /** Invoke through an on-demand provider leg, then release it at quiescence. */
  async invoke(record: LiveCapabilityRecord, path: string[], args: unknown[]): Promise<unknown> {
    const active = await this.#acquire(record);
    try {
      return await active.invoker.invoke(path, args);
    } finally {
      this.#release(active);
    }
  }

  /** Retire one exact mount and optionally notify its relay by closing the socket. */
  remove(record: LiveCapabilityRecord, options: { notifyRelay?: boolean } = {}): void {
    const key = record.providerBinding.socketId;
    const entry = this.#entryFor(record);
    if (options.notifyRelay !== false && entry !== undefined) {
      this.#leases.close(entry.ws, LIVE_CAPABILITY_RETIRED_CLOSE_CODE, "live capability retired");
    }
    const active = this.#activeProviders.get(key);
    if (active !== undefined) {
      this.#activeProviders.delete(key);
      try {
        active.invoker[Symbol.dispose]();
      } catch (error) {
        console.error("live capability provider disposal failed during removal", {
          error,
          path: active.record.path,
          providedAtOffset: active.record.providedAtOffset,
        });
      }
    }
    this.#failPending(key, new Error(`capability "${record.path.join(".")}" is offline`));
  }

  handleError(ws: WebSocket, error: unknown): void {
    this.#leases.handleError(ws, error);
  }

  async #acquire(record: LiveCapabilityRecord): Promise<ActiveProvider> {
    const key = record.providerBinding.socketId;
    let active = this.#activeProviders.get(key);
    if (active === undefined) {
      let pending = this.#pendingProviders.get(key);
      if (pending === undefined) pending = this.#requestProvider(record);
      await pending.promise;
      active = this.#activeProviders.get(key);
      if (active === undefined) {
        throw new Error(`capability "${record.path.join(".")}" provider attach completed empty`);
      }
    }
    active.inFlight += 1;
    return active;
  }

  #requestProvider(record: LiveCapabilityRecord): PendingProvider {
    const entry = this.#entryFor(record);
    if (entry === undefined) {
      throw new Error(`capability "${record.path.join(".")}" is offline`);
    }
    const key = record.providerBinding.socketId;
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    const pending: PendingProvider = {
      promise,
      reject,
      resolve,
      timer: setTimeout(() => {
        if (this.#pendingProviders.get(key) !== pending) return;
        this.#failPending(
          key,
          new Error(
            `capability "${record.path.join(".")}" provider did not attach within ${PROVIDER_ATTACH_TIMEOUT_MS}ms`,
          ),
        );
      }, PROVIDER_ATTACH_TIMEOUT_MS),
    };
    this.#pendingProviders.set(key, pending);
    if (!this.#leases.send(entry.ws, { type: "wake" })) {
      this.#failPending(key, new Error(`capability "${record.path.join(".")}" wake failed`));
    }
    return pending;
  }

  #release(active: ActiveProvider): void {
    active.inFlight -= 1;
    if (active.inFlight > 0) return;
    const key = active.record.providerBinding.socketId;
    if (this.#activeProviders.get(key) !== active) return;
    this.#activeProviders.delete(key);
    try {
      active.invoker[Symbol.dispose]();
    } catch (error) {
      console.error("live capability provider disposal failed at idle", {
        error,
        path: active.record.path,
        providedAtOffset: active.record.providedAtOffset,
      });
    }
    const entry = this.#entryFor(active.record);
    if (entry !== undefined) this.#leases.send(entry.ws, { type: "idle" });
  }

  #failPending(key: string, error: Error): void {
    const pending = this.#pendingProviders.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingProviders.delete(key);
    pending.reject(error);
  }

  #entryFor(record: LiveCapabilityRecord) {
    const { socketId } = record.providerBinding;
    return this.#leases.entries(socketId).find(({ binding }) => binding.socketId === socketId);
  }
}

function isLiveCapabilityInvoker(value: unknown): value is LiveCapabilityInvoker {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "invoke" in value &&
    typeof value.invoke === "function"
  );
}
