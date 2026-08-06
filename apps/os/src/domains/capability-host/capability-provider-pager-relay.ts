// Stateless client-side owner of a Capability Provider Pager.
//
// The provider client gives one capability scope this hibernatable WebSocket
// and retains any number of providers here. The scope's capability-host runs
// as a FACET of its Stream Durable Object, and the Pager's runtime half (the
// socket, lent RPC legs, pending activations) is parent-held — so this relay
// dials the STREAM Durable Object: its fetch accepts the Pager upgrade and
// its capability doors serialize the control-plane mutations before
// forwarding to the facet. The DO releases ordinary RPC references while
// idle, then sends a mount-specific Page asking this relay to lend it a
// short RPC leg. The connected event and each provided event are durable;
// the random pagerDialId and the RPC legs are transport details only.

import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { dialHibernatablePager, parseHibernatablePage } from "../hibernatable-pager.ts";
import { assertCapabilityPath } from "./capability-path.ts";
import { retainLiveCapabilityProvider, type LiveCapability } from "./live-capability.ts";
import {
  CAPABILITY_PROVIDER_PAGER_HEADER,
  type CapabilityProviderInvoker,
} from "./capability-provider-pager.ts";
import type {
  CapabilityProvidedPayload,
  ProvideCapabilityInput,
  RevokeCapabilityInput,
} from "./types.ts";

type LiveProvideInput = Extract<ProvideCapabilityInput, { type: "live" }>;

type CapabilityProviderPagerProvision = {
  isActive(): boolean;
  path: string[];
  providedAtOffset: number;
  revoke(input: RevokeCapabilityInput): Promise<void>;
};

type MountedProvider = {
  activeLeg?: Disposable;
  path: string[];
  providedAtOffset: number;
  provider: LiveCapability;
};

const CapabilityProviderPage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("activate"), providedAtOffset: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("idle"), providedAtOffset: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("retire"), providedAtOffset: z.number().int().nonnegative() }),
]);

/** One short RPC leg from this relay's retained provider into the active DO. */
class CapabilityProviderInvokerRpcTarget extends RpcTarget implements CapabilityProviderInvoker {
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
 * The scope's Stream Durable Object surface this relay dials: the real
 * `fetch()` the Pager upgrade rides, plus the parent-side capability doors
 * (see the Capability Provider Pagers section in stream-durable-object.ts).
 */
type CapabilityHostStreamStub = {
  activateLiveCapability(input: {
    connectedAtOffset: number;
    invoker: CapabilityProviderInvoker;
    providedAtOffset: number;
  }): Promise<Disposable | undefined>;
  connectCapabilityProviderPager(input: { pagerDialId: string }): Promise<number>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  provideCapability(
    record: CapabilityProvidedPayload,
  ): Promise<{ path: string[]; providedAtOffset: number }>;
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
};

/** One client-given Pager shared by every live provider mounted through this relay. */
export class CapabilityProviderPagerRelay {
  readonly #durableObject: CapabilityHostStreamStub;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  readonly #mounts = new Map<number, MountedProvider>();
  #connectedAtOffset: number | undefined;
  #operationTail = Promise.resolve();
  #pager: WebSocket | undefined;

  constructor(input: {
    env: Env;
    scope: { path: string; projectId: string };
    waitUntil(promise: Promise<unknown>): void;
  }) {
    const path = normalizePath(input.scope.path);
    // Safe: the STREAM stub's generated RPC surface carries exactly these
    // capability doors (plus much more this relay never dials); the
    // hand-declared CapabilityHostStreamStub swaps the deep generated
    // DurableObjectStub type for the plain subset, the same seam pattern as
    // the facet relays' ParentStreamStub.
    this.#durableObject = input.env.STREAM.getByName(
      DurableObjectNameCodec.stringify({ path, projectId: input.scope.projectId }),
    ) as unknown as CapabilityHostStreamStub;
    this.#waitUntil = input.waitUntil;
  }

  provide(input: LiveProvideInput): Promise<CapabilityProviderPagerProvision> {
    return this.#enqueue(() => this.#provide(input));
  }

  async #provide(input: LiveProvideInput): Promise<CapabilityProviderPagerProvision> {
    assertCapabilityPath(input.path);
    if (!Object.hasOwn(input, "capability")) {
      throw new Error('live capabilities require "capability"');
    }

    const provider = retainLiveCapabilityProvider(input.capability, {
      flattenNestedPath: input.flattenNestedPaths === true,
    });
    try {
      const connectedAtOffset = await this.#ensurePager();
      const record: CapabilityProvidedPayload = {
        flattenNestedPaths: input.flattenNestedPaths === true ? true : undefined,
        instructions: input.instructions,
        path: input.path,
        providerPager: { connectedAtOffset },
        type: "live",
        types: input.types,
      };
      const provision = await this.#durableObject.provideCapability(record);
      const mounted = { ...provision, provider } satisfies MountedProvider;
      this.#mounts.set(provision.providedAtOffset, mounted);
      return this.#provisionHandle(mounted);
    } catch (error) {
      provider.dispose();
      throw error;
    }
  }

  async #ensurePager(): Promise<number> {
    if (this.#pager !== undefined && this.#connectedAtOffset !== undefined) {
      return this.#connectedAtOffset;
    }

    const pagerDialId = crypto.randomUUID();
    const pager = await dialHibernatablePager({
      headerName: CAPABILITY_PROVIDER_PAGER_HEADER,
      headerValue: { pagerDialId },
      stub: this.#durableObject,
      url: "https://capability-provider-pager.internal/",
    });
    this.#pager = pager;
    pager.addEventListener("message", (event) => this.#enqueuePage(pager, event.data));
    pager.addEventListener("close", () => this.#enqueuePagerClosed(pager));
    pager.addEventListener("error", () => this.#enqueuePagerClosed(pager));

    try {
      const connectedAtOffset = await this.#durableObject.connectCapabilityProviderPager({
        pagerDialId,
      });
      if (this.#pager !== pager)
        throw new Error("Capability Provider Pager closed while connecting");
      this.#connectedAtOffset = connectedAtOffset;
      return connectedAtOffset;
    } catch (error) {
      if (this.#pager === pager) this.#pager = undefined;
      try {
        pager.close(1011, "Capability Provider Pager connection failed");
      } catch {
        // Already closed.
      }
      throw error;
    }
  }

  #provisionHandle(mounted: MountedProvider): CapabilityProviderPagerProvision {
    return {
      isActive: () => this.#mounts.get(mounted.providedAtOffset) === mounted,
      path: mounted.path,
      providedAtOffset: mounted.providedAtOffset,
      revoke: (input) =>
        this.#enqueue(async () => {
          try {
            await this.#durableObject.revokeCapability(input);
          } finally {
            this.#retireMount(mounted.providedAtOffset);
          }
        }),
    };
  }

  #enqueuePage(pager: WebSocket, data: unknown): void {
    const page = parseHibernatablePage(data, CapabilityProviderPage);
    if (page === undefined) return;
    const task = this.#enqueue(async () => {
      if (this.#pager !== pager) return;
      try {
        await this.#handlePage(page);
      } catch (error) {
        await this.#failMount(page.providedAtOffset, error);
      }
    });
    this.#waitUntil(task);
  }

  #enqueuePagerClosed(pager: WebSocket): void {
    const task = this.#enqueue(() => {
      if (this.#pager !== pager) return;
      this.#pager = undefined;
      this.#connectedAtOffset = undefined;
      for (const providedAtOffset of [...this.#mounts.keys()]) {
        this.#retireMount(providedAtOffset);
      }
    });
    this.#waitUntil(task);
  }

  async #handlePage(page: z.infer<typeof CapabilityProviderPage>): Promise<void> {
    const mounted = this.#mounts.get(page.providedAtOffset);
    if (mounted === undefined) return;
    if (page.type === "retire") {
      this.#retireMount(page.providedAtOffset);
      return;
    }
    if (page.type === "idle") {
      this.#releaseActiveLeg(mounted);
      return;
    }

    const connectedAtOffset = this.#connectedAtOffset;
    if (connectedAtOffset === undefined) return;
    const activeLeg = await this.#durableObject.activateLiveCapability({
      connectedAtOffset,
      invoker: new CapabilityProviderInvokerRpcTarget(mounted.provider),
      providedAtOffset: mounted.providedAtOffset,
    });
    // No leg means this Page lost a pending-activation race and is stale.
    if (activeLeg === undefined) return;
    this.#releaseActiveLeg(mounted);
    if (this.#mounts.get(mounted.providedAtOffset) === mounted) mounted.activeLeg = activeLeg;
    else activeLeg[Symbol.dispose]();
  }

  async #failMount(providedAtOffset: number, error: unknown): Promise<void> {
    const mounted = this.#mounts.get(providedAtOffset);
    if (mounted === undefined) return;
    this.#retireMount(providedAtOffset);
    try {
      await this.#durableObject.revokeCapability({
        path: mounted.path,
        providedAtOffset,
      });
    } catch (revokeError) {
      console.error("live provider activation and rollback failed", {
        error: new AggregateError([error, revokeError]),
        path: mounted.path,
        providedAtOffset,
      });
    }
  }

  #retireMount(providedAtOffset: number): void {
    const mounted = this.#mounts.get(providedAtOffset);
    if (mounted === undefined) return;
    this.#mounts.delete(providedAtOffset);
    this.#releaseActiveLeg(mounted);
    try {
      mounted.provider.dispose();
    } catch (error) {
      console.error("live provider disposal failed", { error, providedAtOffset });
    }
  }

  #releaseActiveLeg(mounted: MountedProvider): void {
    const activeLeg = mounted.activeLeg;
    if (activeLeg === undefined) return;
    mounted.activeLeg = undefined;
    try {
      activeLeg[Symbol.dispose]();
    } catch (error) {
      console.error("live provider call leg disposal failed", {
        error,
        providedAtOffset: mounted.providedAtOffset,
      });
    }
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
