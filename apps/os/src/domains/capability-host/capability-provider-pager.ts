// The Capability Provider Pager is a WebSocket that a provider client gives to one
// CapabilityHost Durable Object: "you may release my ordinary RPC references;
// Page this return channel when one of my mounted capabilities is called."
//
// One Pager owns any number of live capability mounts. The durable
// `capability-provider-pager-connected` event identifies the Pager by its offset;
// each `capability-provided` event references that `connectedAtOffset` and
// keeps its own `providedAtOffset` mount identity. The random `pagerDialId`
// below only correlates an in-flight WebSocket upgrade with the connect RPC;
// it never identifies a Pager in events or processor state.

import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { HibernatablePagers } from "../hibernatable-pager.ts";
import type { CapabilityRecord } from "./types.ts";
import { deepRetainRpcStubs } from "./live-capability.ts";

type LiveCapabilityRecord = Extract<CapabilityRecord, { type: "live" }>;

/** Internal upgrade marker; no external ingress route addresses a CapabilityHost DO. */
export const CAPABILITY_PROVIDER_PAGER_HEADER = "x-iterate-capability-provider-pager";

const CAPABILITY_PROVIDER_PAGER_TAG = "capability-provider-pager";
const PROVIDER_ATTACH_TIMEOUT_MS = 10_000;

const CapabilityProviderPagerUpgrade = z
  .strictObject({ pagerDialId: z.string().trim().min(1) })
  .transform(({ pagerDialId }) => ({ pagerId: pagerDialId, pagerKey: pagerDialId }));

const CapabilityProviderPagerAttachment = z.discriminatedUnion("state", [
  z.strictObject({
    v: z.literal(1),
    pagerDialId: z.string().min(1),
    state: z.literal("opening"),
  }),
  z.strictObject({
    v: z.literal(1),
    connectedAtOffset: z.number().int().nonnegative(),
    pagerDialId: z.string().min(1),
    state: z.literal("connected"),
  }),
]);

type CapabilityProviderPagerAttachment = z.infer<typeof CapabilityProviderPagerAttachment>;

export type CapabilityProviderPagerActivation = {
  connectedAtOffset: number;
  invoker: unknown;
  providedAtOffset: number;
};

export type CapabilityProviderInvoker = {
  invoke(path: string[], args: unknown[]): unknown;
};

/** Retaining this short RPC leg keeps one provider reachable during one invocation burst. */
export class CapabilityProviderCallLegRpcTarget extends RpcTarget {}

type ActiveProvider = {
  invoker: CapabilityProviderInvoker & Disposable;
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

type CapabilityProviderPagerHooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

/** Durable-Object adapter for client-given Capability Provider Pagers. */
export class CapabilityProviderPagers {
  readonly #pagers: HibernatablePagers<CapabilityProviderPagerAttachment>;
  readonly #activeProviders = new Map<number, ActiveProvider>();
  readonly #pendingProviders = new Map<number, PendingProvider>();

  constructor(hooks: CapabilityProviderPagerHooks) {
    this.#pagers = new HibernatablePagers({
      attachmentSchema: CapabilityProviderPagerAttachment,
      bindingOf: ({ pagerDialId }) => ({ pagerId: pagerDialId, pagerKey: pagerDialId }),
      createAttachment: ({ pagerId }) => ({ v: 1, pagerDialId: pagerId, state: "opening" }),
      headerName: CAPABILITY_PROVIDER_PAGER_HEADER,
      hooks,
      lane: "live provider",
      pagerTag: CAPABILITY_PROVIDER_PAGER_TAG,
      upgradeSchema: CapabilityProviderPagerUpgrade,
    });
  }

  acceptUpgrade(request: Request): Response {
    return this.#pagers.acceptUpgrade(request);
  }

  /** Bind the connected event to the exact Pager that prompted it. */
  connect(pagerDialId: string, connectedAtOffset: number): boolean {
    const claimed = this.#pagers.claim({ pagerId: pagerDialId, pagerKey: pagerDialId });
    if (claimed === undefined) return false;
    return this.#pagers.stamp(claimed.ws, {
      v: 1,
      connectedAtOffset,
      pagerDialId,
      state: "connected",
    });
  }

  /** Connected event owned by this physical Pager, if binding completed. */
  connectedAtOffset(ws: WebSocket): number | undefined {
    const attachment = this.#pagers.attachment(ws);
    return attachment?.state === "connected" ? attachment.connectedAtOffset : undefined;
  }

  /** Whether runtime socket inventory still contains this exact durable Pager. */
  hasPager(connectedAtOffset: number): boolean {
    return this.#entryFor(connectedAtOffset) !== undefined;
  }

  /** Adopt one short provider leg after an activation Page. */
  activate(
    input: CapabilityProviderPagerActivation,
    record: LiveCapabilityRecord,
  ): CapabilityProviderCallLegRpcTarget | undefined {
    const key = record.providedAtOffset;
    const pending = this.#pendingProviders.get(key);
    if (
      pending === undefined ||
      input.connectedAtOffset !== record.providerPager.connectedAtOffset ||
      this.#entryFor(record.providerPager.connectedAtOffset) === undefined
    ) {
      return undefined;
    }

    const retainedInvoker = deepRetainRpcStubs(input.invoker);
    const invoker = retainedInvoker.value;
    if (!isCapabilityProviderInvoker(invoker)) {
      retainedInvoker.dispose();
      const error = new Error("live provider activation requires an invoker RPC target");
      this.#failPending(key, error);
      throw error;
    }

    const activeInvoker: CapabilityProviderInvoker & Disposable = {
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
      return new CapabilityProviderCallLegRpcTarget();
    } catch (error) {
      if (this.#activeProviders.get(key) === active) this.#activeProviders.delete(key);
      activeInvoker[Symbol.dispose]();
      this.#failPending(key, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /** Invoke one mount through an on-demand provider leg, then release it at quiescence. */
  async invoke(record: LiveCapabilityRecord, path: string[], args: unknown[]): Promise<unknown> {
    const active = await this.#acquire(record);
    try {
      return await active.invoker.invoke(path, args);
    } finally {
      this.#release(active);
    }
  }

  /** Retire one mount without disturbing sibling mounts on the same Pager. */
  removeMount(record: LiveCapabilityRecord): void {
    const key = record.providedAtOffset;
    const entry = this.#entryFor(record.providerPager.connectedAtOffset);
    if (entry !== undefined) {
      this.#pagers.page(entry.ws, { type: "retire", providedAtOffset: key });
    }
    this.#disposeActive(key, "removal");
    this.#failPending(key, new Error(`capability "${record.path.join(".")}" is offline`));
  }

  /** Retire every mount owned by one disconnected Pager. */
  removePager(connectedAtOffset: number): void {
    for (const [key, active] of this.#activeProviders) {
      if (active.record.providerPager.connectedAtOffset !== connectedAtOffset) continue;
      this.#disposeActive(key, "Pager disconnection");
    }
    for (const [key, pending] of this.#pendingProviders) {
      if (pending.record.providerPager.connectedAtOffset !== connectedAtOffset) continue;
      this.#failPending(key, new Error(`capability "${pending.record.path.join(".")}" is offline`));
    }
  }

  handleError(ws: WebSocket, error: unknown): void {
    this.#pagers.handleError(ws, error);
  }

  async #acquire(record: LiveCapabilityRecord): Promise<ActiveProvider> {
    const key = record.providedAtOffset;
    let active = this.#activeProviders.get(key);
    if (active === undefined) {
      let pending = this.#pendingProviders.get(key);
      pending ??= this.#requestProvider(record);
      await pending.promise;
      active = this.#activeProviders.get(key);
      if (active === undefined) {
        throw new Error(
          `capability "${record.path.join(".")}" provider activation completed empty`,
        );
      }
    }
    active.inFlight += 1;
    return active;
  }

  #requestProvider(record: LiveCapabilityRecord): PendingProvider {
    const entry = this.#entryFor(record.providerPager.connectedAtOffset);
    if (entry === undefined) throw new Error(`capability "${record.path.join(".")}" is offline`);
    const key = record.providedAtOffset;
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    const pending: PendingProvider = {
      promise,
      record,
      reject,
      resolve,
      timer: setTimeout(() => {
        if (this.#pendingProviders.get(key) !== pending) return;
        this.#failPending(
          key,
          new Error(
            `capability "${record.path.join(".")}" provider did not activate within ${PROVIDER_ATTACH_TIMEOUT_MS}ms`,
          ),
        );
      }, PROVIDER_ATTACH_TIMEOUT_MS),
    };
    this.#pendingProviders.set(key, pending);
    if (!this.#pagers.page(entry.ws, { type: "activate", providedAtOffset: key })) {
      this.#failPending(key, new Error(`capability "${record.path.join(".")}" Page failed`));
    }
    return pending;
  }

  #release(active: ActiveProvider): void {
    active.inFlight -= 1;
    if (active.inFlight > 0) return;
    const key = active.record.providedAtOffset;
    if (this.#activeProviders.get(key) !== active) return;
    this.#activeProviders.delete(key);
    try {
      active.invoker[Symbol.dispose]();
    } catch (error) {
      console.error("live provider disposal failed at idle", {
        error,
        path: active.record.path,
        providedAtOffset: key,
      });
    }
    const entry = this.#entryFor(active.record.providerPager.connectedAtOffset);
    if (entry !== undefined) this.#pagers.page(entry.ws, { type: "idle", providedAtOffset: key });
  }

  #disposeActive(key: number, reason: string): void {
    const active = this.#activeProviders.get(key);
    if (active === undefined) return;
    this.#activeProviders.delete(key);
    try {
      active.invoker[Symbol.dispose]();
    } catch (error) {
      console.error(`live provider disposal failed during ${reason}`, {
        error,
        path: active.record.path,
        providedAtOffset: key,
      });
    }
  }

  #failPending(key: number, error: Error): void {
    const pending = this.#pendingProviders.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingProviders.delete(key);
    pending.reject(error);
  }

  #entryFor(connectedAtOffset: number) {
    return this.#pagers
      .entries()
      .find(
        ({ attachment }) =>
          attachment.state === "connected" && attachment.connectedAtOffset === connectedAtOffset,
      );
  }
}

function isCapabilityProviderInvoker(value: unknown): value is CapabilityProviderInvoker {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "invoke" in value &&
    typeof value.invoke === "function"
  );
}
