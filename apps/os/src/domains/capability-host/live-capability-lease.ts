import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import {
  HibernatableRpcLeaseSockets,
  type HibernatableRpcLeaseBinding,
} from "../hibernatable-rpc-lease.ts";
import type { CapabilityRecord } from "./types.ts";
import { deepRetainRpcStubs } from "./live-capability.ts";

type LiveCapabilityRecord = Extract<CapabilityRecord, { type: "live" }>;

/** Internal upgrade marker; no external ingress route addresses a CapabilityHost DO. */
export const LIVE_CAPABILITY_LEASE_HEADER = "x-iterate-live-capability-lease";

const LIVE_CAPABILITY_LEASE_TAG = "live-capability-lease";
const PROVIDER_ATTACH_TIMEOUT_MS = 10_000;

const LiveCapabilityChannelUpgrade = z
  .object({
    channelKey: z.string().trim().min(1),
    socketId: z.string().trim().min(1),
  })
  .transform(({ channelKey, socketId }) => ({ leaseKey: channelKey, socketId }));

const LiveCapabilityChannelAttachment = z.object({
  v: z.literal(2),
  channelKey: z.string().min(1),
  socketId: z.string().min(1),
});

type LiveCapabilityChannelAttachment = z.infer<typeof LiveCapabilityChannelAttachment>;

const LiveCapabilityLeaseFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle"), leaseKey: z.string().min(1) }),
  z.object({ type: z.literal("retire"), leaseKey: z.string().min(1) }),
  z.object({ type: z.literal("wake"), leaseKey: z.string().min(1) }),
]);

type LiveCapabilityLeaseFrame = z.infer<typeof LiveCapabilityLeaseFrame>;

/** Decode one addressed channel frame; malformed frames are dropped whole. */
export function parseLiveCapabilityLeaseFrame(data: unknown): LiveCapabilityLeaseFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = LiveCapabilityLeaseFrame.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type LiveCapabilityLeaseActivation = {
  channelKey: string;
  invoker: unknown;
  leaseKey: string;
  path: string[];
  providedAtOffset: number;
  socketId: string;
};

export type LiveCapabilityInvoker = {
  invoke(path: string[], args: unknown[]): unknown;
};

/**
 * Worker-side anchor for one active provider leg. Retaining its returned stub
 * keeps the same Workers RPC session alive while the DO has in-flight calls;
 * the relay disposes it on the DO's addressed `idle` frame.
 */
export class LiveCapabilityLegRpcTarget extends RpcTarget {}

type ActiveProvider = {
  invoker: LiveCapabilityInvoker & Disposable;
  inFlight: number;
  record: LiveCapabilityRecord;
};

type PendingProvider = {
  promise: Promise<void>;
  record: LiveCapabilityRecord;
  reject(error: Error): void;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
};

type LiveCapabilityLeaseHooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

/**
 * The CapabilityHost DO's half of a multiplexed provider channel.
 *
 * One hibernatable socket represents one stateless session/CapabilityHost
 * pair; durable capability records address the logical provider by
 * `{channelKey, socketId, leaseKey}`. The DO therefore retains neither the provider RPC
 * stub nor one WebSocket per provider while idle. This deliberately emulates
 * the recreatable outbound-stub store Kenton describes for future native
 * hibernatable Workers RPC:
 * https://github.com/cloudflare/capnweb/issues/36#issuecomment-4040638107
 *
 * A provider is duplicated into this incarnation only after its addressed
 * `wake` frame, and is released as soon as the concurrent invocation burst
 * drains. The socket attachment contains only channel identity, so the same
 * channel can carry arbitrarily many durable logical bindings without making
 * the attachment proportional to provider count. Ordinary durable-state,
 * event, CPU, and memory limits still bound the logical population.
 */
export class LiveCapabilityLeaseServer {
  readonly #leases: HibernatableRpcLeaseSockets<
    LiveCapabilityChannelAttachment,
    LiveCapabilityLeaseFrame
  >;
  readonly #activeProviders = new Map<string, ActiveProvider>();
  readonly #departedSockets = new Set<string>();
  readonly #pendingProviders = new Map<string, PendingProvider>();
  readonly #retiredRecords = new Map<string, number>();

  constructor(hooks: LiveCapabilityLeaseHooks) {
    this.#leases = new HibernatableRpcLeaseSockets({
      attachmentSchema: LiveCapabilityChannelAttachment,
      bindingOf: ({ channelKey, socketId }) => ({ leaseKey: channelKey, socketId }),
      createAttachment: ({ leaseKey, socketId }) => ({
        v: 2,
        channelKey: leaseKey,
        socketId,
      }),
      headerName: LIVE_CAPABILITY_LEASE_HEADER,
      hooks,
      lane: "live capability",
      socketTag: LIVE_CAPABILITY_LEASE_TAG,
      upgradeSchema: LiveCapabilityChannelUpgrade,
    });
  }

  acceptUpgrade(request: Request): Response {
    return this.#leases.acceptUpgrade(request);
  }

  /** Bind a durable provision to its already-accepted shared channel. */
  bindProvision(record: LiveCapabilityRecord, channel: HibernatableRpcLeaseBinding): boolean {
    if (
      record.providerBinding?.channelKey !== channel.leaseKey ||
      record.providerBinding.socketId !== channel.socketId
    ) {
      return false;
    }
    if (this.#departedSockets.has(bindingKey(channel))) return false;
    return this.#leases.claim(channel) !== undefined;
  }

  /** True when a durable record still has a live hibernatable owner channel. */
  hasLease(record: LiveCapabilityRecord): boolean {
    if (this.#retiredRecords.has(recordKey(record))) return false;
    const entry = this.#entryFor(record);
    return entry !== undefined && !this.#departedSockets.has(bindingKey(entry.binding));
  }

  /**
   * Adopt one short provider leg after a wake. A stale or unsolicited attach
   * is refused: retaining it would recreate the idle pin this protocol removes.
   */
  activate(
    input: LiveCapabilityLeaseActivation,
    record: LiveCapabilityRecord,
  ): LiveCapabilityLegRpcTarget | undefined {
    const key = recordKey(record);
    const pending = this.#pendingProviders.get(key);
    if (pending === undefined) return undefined;
    const entry = this.#entryFor(record);
    if (
      entry === undefined ||
      entry.binding.leaseKey !== input.channelKey ||
      entry.binding.socketId !== input.socketId ||
      record.providerBinding?.leaseKey !== input.leaseKey ||
      record.providerBinding.socketId !== input.socketId
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

  /** Remove one exact logical lease without disturbing its sibling providers. */
  remove(record: LiveCapabilityRecord, options: { notifyRelay?: boolean } = {}): Disposable {
    const key = recordKey(record);
    const entry = this.#entryFor(record);
    const leaseKey = record.providerBinding?.leaseKey;
    if (options.notifyRelay !== false && entry !== undefined && leaseKey !== undefined) {
      this.#leases.send(entry.ws, { type: "retire", leaseKey });
    }
    this.#retiredRecords.set(key, (this.#retiredRecords.get(key) ?? 0) + 1);

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
    let settled = false;
    return {
      [Symbol.dispose]: () => {
        if (settled) return;
        settled = true;
        const remaining = (this.#retiredRecords.get(key) ?? 1) - 1;
        if (remaining === 0) this.#retiredRecords.delete(key);
        else this.#retiredRecords.set(key, remaining);
      },
    };
  }

  /** Mark one exact physical-channel epoch departed, even if a replacement exists. */
  departedOnClose(ws: WebSocket): { channelKey: string; socketId: string } | undefined {
    const attachment = this.#leases.attachment(ws);
    if (attachment === undefined) return undefined;
    this.#departedSockets.add(
      bindingKey({ leaseKey: attachment.channelKey, socketId: attachment.socketId }),
    );
    return { channelKey: attachment.channelKey, socketId: attachment.socketId };
  }

  /** Release one departed-socket guard after every record it owned is durably gone. */
  settleDeparture(binding: { channelKey: string; socketId: string }): void {
    const leaseBinding = { leaseKey: binding.channelKey, socketId: binding.socketId };
    const stillOwned = this.#leases
      .entries(binding.channelKey)
      .some(({ binding: candidate }) => candidate.socketId === binding.socketId);
    if (!stillOwned) this.#departedSockets.delete(bindingKey(leaseBinding));
  }

  /**
   * Recover guards whose mutation returned ambiguously but whose caught-up
   * durable state now proves that the guarded record or socket is unreferenced.
   */
  settleDurableState(records: LiveCapabilityRecord[]): void {
    const recordKeys = new Set(records.map(recordKey));
    for (const key of this.#retiredRecords.keys()) {
      if (!recordKeys.has(key)) this.#retiredRecords.delete(key);
    }
    const bindingKeys = new Set(
      records.flatMap((record) => {
        const binding = record.providerBinding;
        return binding?.socketId === undefined
          ? []
          : [bindingKey({ leaseKey: binding.channelKey, socketId: binding.socketId })];
      }),
    );
    const runtimeBindingKeys = new Set(
      this.#leases.entries().map(({ binding }) => bindingKey(binding)),
    );
    for (const key of this.#departedSockets) {
      if (!bindingKeys.has(key) && !runtimeBindingKeys.has(key)) this.#departedSockets.delete(key);
    }
  }

  handleError(ws: WebSocket, error: unknown): void {
    this.#leases.handleError(ws, error);
  }

  async #acquire(record: LiveCapabilityRecord): Promise<ActiveProvider> {
    const key = recordKey(record);
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
    const leaseKey = record.providerBinding?.leaseKey;
    if (entry === undefined || leaseKey === undefined) {
      throw new Error(`capability "${record.path.join(".")}" is offline`);
    }
    const key = recordKey(record);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: PendingProvider = {
      promise,
      record,
      reject,
      resolve,
      timer: setTimeout(() => {
        const current = this.#pendingProviders.get(key);
        if (current !== pending) return;
        this.#failPending(
          key,
          new Error(
            `capability "${record.path.join(".")}" provider did not attach within ${PROVIDER_ATTACH_TIMEOUT_MS}ms`,
          ),
        );
      }, PROVIDER_ATTACH_TIMEOUT_MS),
    };
    this.#pendingProviders.set(key, pending);
    if (!this.#leases.send(entry.ws, { type: "wake", leaseKey })) {
      this.#failPending(key, new Error(`capability "${record.path.join(".")}" wake failed`));
    }
    return pending;
  }

  #release(active: ActiveProvider): void {
    active.inFlight -= 1;
    if (active.inFlight > 0) return;
    const key = recordKey(active.record);
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
    const leaseKey = active.record.providerBinding?.leaseKey;
    if (entry !== undefined && leaseKey !== undefined) {
      this.#leases.send(entry.ws, { type: "idle", leaseKey });
    }
  }

  #failPending(key: string, error: Error): void {
    const pending = this.#pendingProviders.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingProviders.delete(key);
    pending.reject(error);
  }

  #entryFor(record: LiveCapabilityRecord) {
    if (this.#retiredRecords.has(recordKey(record))) return undefined;
    const binding = record.providerBinding;
    if (binding?.socketId === undefined) return undefined;
    return this.#leases
      .entries(binding.channelKey)
      .find(({ binding: candidate }) => candidate.socketId === binding.socketId);
  }
}

function recordKey(record: LiveCapabilityRecord): string {
  return JSON.stringify([record.path, record.providedAtOffset]);
}

function bindingKey(binding: HibernatableRpcLeaseBinding): string {
  return JSON.stringify([binding.leaseKey, binding.socketId]);
}

function isLiveCapabilityInvoker(value: unknown): value is LiveCapabilityInvoker {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "invoke" in value &&
    typeof value.invoke === "function"
  );
}
