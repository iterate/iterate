// Facet hosting for stream processors: the SAME `createStreamProcessorRegistry`
// machinery a processor-hosting Durable Object runs, placed inside a Durable
// Object FACET of the stream it serves (tasks/stream-processors-as-facets.md).
// Checkpoints and projections land in the facet's own private SQLite under the
// standard keys; the ONLY adaptation between placements is durable alarms:
// workerd does not implement alarms for facets (workerd#6810 — a facet
// `setAlarm` even appears to succeed locally, then poisons the facet's output
// gate), so the parent keeps the real platform alarm on the facet's behalf and
// the facet dials three proxy verbs on it. Everything else is verbatim.
//
// Identity follows the creation-is-an-event doctrine adapted to facets: a
// facet can never receive constructor arguments from its parent, so its
// coordinate — parent Durable Object name, project, stream path — arrives
// through a first-contact `configure()` call and is stashed durably in the
// facet's own kv. Every later incarnation (including the fresh one a replayed
// alarm boots) reconstructs its host from that stash alone.

import { DurableObject } from "cloudflare:workers";
import type { LiveStateRpc } from "../sdk/capnweb/live-state/types.ts";
import { disposeIgnoredRpcResult } from "../sdk/capnweb/live-state/retain.ts";
import type { ProcessorStream } from "./stream-handle.ts";
import type { MaybePromise } from "./stream-processor.ts";
import type {
  ProcessorRuntimeState,
  ProcessorSnapshot,
  StreamProcessorWakeRequest,
  StreamProcessorWakeResponse,
} from "./rpc-types.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "./stream-processor-registry.ts";

/**
 * Where the configured identity lives in the facet's own kv. Exported so a
 * subclass's own doors can self-heal a fresh incarnation (re-run the
 * idempotent `configure` from the stash) before the base's boot microtask has
 * run — see apps/os `ProcessorFacet.#requireRegistry`.
 */
export const FACET_IDENTITY_KEY = "iterate:processor-facet:identity";

/**
 * The identity a {@link ProcessorFacet} is configured with on first contact —
 * stashed durably in the facet's own kv, never passed again. `path` +
 * `projectId` are the registry's wake coordinate fence; `parentName` is how
 * the facet dials BACK to the Durable Object hosting it (the Stream DO) for
 * the alarm proxy.
 */
export type ProcessorFacetIdentity = {
  /** Durable Object name of the hosting parent (the Stream DO). */
  parentName: string;
  /** Owning project of the hosted stream, or null on a deployment-global stream. */
  projectId: string | null;
  /** Path of the hosted stream. */
  path: string;
};

/**
 * The three parent-side alarm doors a facet dials in place of its own
 * (unimplemented) `ctx.storage` alarm verbs. The parent implements them over
 * its REAL platform alarm and replays each fire into the facet's
 * {@link ProcessorFacet.handleAlarm}. The parent's implementations MUST
 * tolerate being called reentrantly while the parent itself is still awaiting
 * `handleAlarm` — the keepalive re-arms from inside its own alarm turn.
 */
export type ProcessorFacetAlarmProxy = {
  proxySetAlarm(scheduledTimeMs: number): MaybePromise<unknown>;
  proxyDeleteAlarm(): MaybePromise<unknown>;
  proxyGetAlarm(): MaybePromise<number | null>;
};

/**
 * Everything app-specific about one facet host, derived from the stashed
 * identity by {@link ProcessorFacet.createHost}: the stream handle processors
 * append through, the worker deploy version (keepalive crash-loop budget
 * reset), and the per-host processor composition — the subclass constructs its
 * processors here and registers each under its subscription name.
 */
export type ProcessorFacetHost = {
  /** The hosted stream — how processors append/read (colocated: a dial back
   * to the parent Stream DO's stream surface). */
  stream: ProcessorStream;
  /** Worker deploy version — pass this worker's build identity. A change
   * resets each keepalive's crash-loop budget (the antidote deploy). */
  version: string;
  /** Injected clock for tests; production omits it (Date.now). */
  now?: () => number;
  /** Assemble this node's live state; omit for the primary runner's fold. */
  getLiveState?: () => Record<string, unknown>;
  /** Construct and register this host's processors (`registry.register(new
   * XProcessor({...}), { recovery, name })`) — called once, right after the
   * registry is built. Per-processor recovery stays the author's explicit
   * choice, exactly as on a hosting DO. */
  registerProcessors(registry: StreamProcessorRegistry): void;
};

/**
 * A view of `target` with `overrides` in front and everything else passed
 * through. Proxies (not spreads or Object.create) because DurableObjectState
 * and DurableObjectStorage are host objects: their methods must be invoked
 * with the REAL receiver or workerd throws "Illegal invocation". (The same
 * overlay as sdk.ts's `selfAlarmState` facade — duplicated here because the
 * sdk entry drags its whole dependency graph along.)
 */
function overlay<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, prop) {
      // Own keys only: `in` would match Object.prototype inherits
      // (toString, …) and shadow the host object's.
      if (Object.hasOwn(overrides, prop)) return overrides[prop];
      const value = Reflect.get(object, prop, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/**
 * A facet's `DurableObjectState` facade for `createStreamProcessorRegistry`:
 * ONLY `storage.setAlarm` / `storage.deleteAlarm` / `storage.getAlarm` are
 * overridden to dial the parent's {@link ProcessorFacetAlarmProxy}; kv,
 * waitUntil, and everything else pass through untouched. `parentAlarms` is
 * invoked PER CALL — the parent stub must be resolved lazily from the stashed
 * identity, because the recovery adapter's boot reconcile issues alarm calls
 * at construction and a stub captured once would outlive its RPC session.
 */
export function facetProcessorDurableObjectState(
  ctx: DurableObjectState,
  parentAlarms: () => ProcessorFacetAlarmProxy,
): DurableObjectState {
  const storage = overlay(ctx.storage, {
    setAlarm: async (scheduledTime: number | Date) => {
      disposeIgnoredRpcResult(
        await parentAlarms().proxySetAlarm(
          typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime(),
        ),
      );
    },
    deleteAlarm: async () => {
      disposeIgnoredRpcResult(await parentAlarms().proxyDeleteAlarm());
    },
    getAlarm: async () => await parentAlarms().proxyGetAlarm(),
  });
  return overlay(ctx, { storage });
}

/**
 * Plain-copy an `AlarmInvocationInfo` before a facet hop. The platform hands
 * the parent's `alarm()` a host object that does not serialize across RPC;
 * a parent replaying a fire into {@link ProcessorFacet.handleAlarm} must send
 * this copy instead.
 */
export function plainAlarmInvocationInfo(
  info: AlarmInvocationInfo | undefined,
): AlarmInvocationInfo | undefined {
  if (!info) return undefined;
  // scheduledTime is absent from this package's ambient AlarmInvocationInfo
  // but present at runtime (and in apps/os's patched types) — carry it through.
  const { scheduledTime } = info as { scheduledTime?: number };
  return {
    ...(!Number.isFinite(scheduledTime) ? {} : { scheduledTime }),
    isRetry: info.isRetry,
    retryCount: info.retryCount,
  } as AlarmInvocationInfo;
}

/**
 * Generic base for hosting stream processors in a Durable Object facet.
 * Subclasses are the per-host composition (the facets task's target shape) and
 * supply exactly two things: how to dial the parent's alarm proxy and what
 * this host runs —
 *
 * ```ts
 * export class AgentProcessors extends ProcessorFacet<Env> {
 *   protected parentAlarms({ parentName }: ProcessorFacetIdentity) {
 *     return this.env.STREAM.getByName(parentName);
 *   }
 *   protected createHost({ path, projectId }: ProcessorFacetIdentity): ProcessorFacetHost {
 *     const stream = ...; // dial the parent stream
 *     return {
 *       stream,
 *       version: workerVersion(this.env),
 *       registerProcessors: (registry) => {
 *         registry.register(
 *           new AgentProcessor({ stream, path, projectId, ... }),
 *           { recovery: true, name: "agent" },
 *         );
 *       },
 *     };
 *   }
 * }
 * ```
 *
 * The parent creates it with `ctx.facets.get(name, () => ({ class:
 * ctx.exports.AgentProcessors }))`, calls `configure()` once (idempotent), and
 * routes wakes/alarms/doors to the RPC surface below.
 *
 * THIS CLASS MUST NEVER DEFINE `alarm()` — and neither may a subclass. The
 * fire arrives as `handleAlarm` (an ordinary RPC verb) instead: workerd
 * reserves `alarm` for its native handler, and with one present a failed
 * native `setAlarm` poisons the facet's output gate (workerd#6810). The
 * constructor enforces this.
 */
export abstract class ProcessorFacet<Env = unknown> extends DurableObject<Env> {
  #host: { registry: StreamProcessorRegistry } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if ("alarm" in this && typeof this.alarm === "function") {
      throw new Error(
        `${this.constructor.name} must not define alarm(): facets have no native alarms ` +
          `(workerd#6810 — a failed setAlarm would poison this facet's output gate). ` +
          `The parent's fire arrives as handleAlarm() instead.`,
      );
    }
    // Boot reconcile: a configured facet rebuilds its host as soon as the
    // incarnation exists — the recovery adapters re-issue any persisted alarm
    // desire (the lost-platform-alarm heal), through the parent proxy. Wrapped in
    // a microtask so the SUBCLASS constructor has finished before its hooks
    // run; failures here only defer construction to the first RPC verb.
    void Promise.resolve().then(() => {
      try {
        if (this.#readIdentity()) this.#requireHost();
      } catch (error) {
        console.error("ProcessorFacet boot host construction failed", error);
      }
    });
  }

  /**
   * Resolve the parent's alarm-proxy stub for the stashed identity — e.g.
   * `this.env.STREAM.getByName(identity.parentName)`. Called once per alarm
   * verb invocation (stubs must not outlive their call turn).
   */
  protected abstract parentAlarms(identity: ProcessorFacetIdentity): ProcessorFacetAlarmProxy;

  /** Build this host's app-specific wiring from the stashed identity — called
   * once per incarnation, lazily on first use. */
  protected abstract createHost(identity: ProcessorFacetIdentity): ProcessorFacetHost;

  // ---------------------------------------------------------------------------
  // RPC surface (parent-only callers).
  // ---------------------------------------------------------------------------

  /**
   * First-contact identity stash, idempotent: re-configuring with the same
   * identity is a no-op (and ensures the host is built); a DIFFERENT identity
   * throws — a facet's coordinate never changes, so a mismatch is a miswire,
   * not a migration.
   */
  configure(identity: ProcessorFacetIdentity): void {
    const stashed = this.#readIdentity();
    if (stashed) {
      if (
        stashed.parentName !== identity.parentName ||
        stashed.projectId !== identity.projectId ||
        stashed.path !== identity.path
      ) {
        throw new Error(
          `ProcessorFacet is configured for ${stashed.projectId ?? "null"}:${stashed.path} ` +
            `(parent "${stashed.parentName}") and cannot be re-configured for ` +
            `${identity.projectId ?? "null"}:${identity.path} (parent "${identity.parentName}")`,
        );
      }
      this.#requireHost();
      return;
    }
    // Plain-copy on stash: keep exactly the declared fields, dropping any RPC
    // envelope decoration the argument object carries.
    this.ctx.storage.kv.put(FACET_IDENTITY_KEY, {
      parentName: identity.parentName,
      projectId: identity.projectId,
      path: identity.path,
    } satisfies ProcessorFacetIdentity);
    this.#requireHost();
  }

  /** The wake door — the parent's colocated delivery dial. Routes to the
   * registry: name-first resolution, coordinate fence, per-batch settlement
   * through each batch's independent `reportDeliveryResult`. */
  wakeStreamProcessor(request: StreamProcessorWakeRequest): Promise<StreamProcessorWakeResponse> {
    return this.#requireHost().registry.wakeStreamProcessor(request);
  }

  /**
   * The parent's alarm replay door — deliberately NOT named `alarm` (see the
   * class doc). The parent plain-copies its `AlarmInvocationInfo`
   * ({@link plainAlarmInvocationInfo}) and awaits this; a rejection propagates
   * so the parent can rethrow and get the platform's alarm retry.
   */
  async handleAlarm(info?: AlarmInvocationInfo): Promise<void> {
    if (!this.#readIdentity()) {
      // No identity means no keepalive record either — nothing to revive. Do
      // not throw: the parent would rethrow into the platform's alarm retry
      // loop with nothing to retry for.
      console.warn("ProcessorFacet.handleAlarm before configure(); nothing to revive");
      return;
    }
    await this.#requireHost().registry.handleAlarm(plainAlarmInvocationInfo(info));
  }

  /** One consistent read of a hosted processor's committed fold. `name` may be
   * omitted on a single-processor host. */
  async snapshot(args?: { name?: string }): Promise<ProcessorSnapshot<unknown>> {
    return await this.#reads(args?.name).snapshot();
  }

  /** The hosted processor's runtime state (runner snapshot + contributed
   * runtime bag). `name` may be omitted on a single-processor host. */
  async getRuntimeState(args?: { name?: string }): Promise<ProcessorRuntimeState> {
    return await this.#reads(args?.name).getRuntimeState();
  }

  /** Resolve once the named processor's acknowledged cursor reaches `offset` —
   * the read-your-writes barrier. The subscription catalog's uniform
   * `waitUntilProcessed` delegates its facet-placed processor rows here. */
  async waitUntilProcessed(args: {
    offset: number;
    timeoutMs?: number;
    name?: string;
  }): Promise<void> {
    const { name, ...input } = args;
    await this.#reads(name).waitUntilEvent(input);
  }

  /** Pull the named processor through the durable stream tail — the parent
   * facade's catch-up-before-snapshot leg, dialed before every facet read.
   * `name` may be omitted on a single-processor host. */
  async catchUp(args?: { name?: string }): Promise<void> {
    await this.#reads(args?.name).catchUp();
  }

  /**
   * The node's live-state door: snapshot + minimal diffs over the registry's
   * engine, hydrated before the first read. The facet hop is Workers RPC,
   * which cannot serialize capnweb RpcTargets, so this returns PLAIN objects
   * of capability functions in the {@link LiveStateRpc} shape — the parent
   * re-wraps them for its own transport. Subscriber callbacks flow INTO the
   * facet as ordinary argument capabilities; the engine dups them on receipt
   * (`retainCallback`) so they survive past the subscribe call.
   */
  liveState(): LiveStateRpc<Record<string, unknown>> {
    const { registry } = this.#requireHost();
    return {
      get: async () => {
        await registry.loadAndRefreshLive();
        return registry.live.getState();
      },
      subscribe: async (onUpdate) => {
        await registry.loadAndRefreshLive();
        const subscription = registry.live.subscribe(onUpdate);
        return {
          ping: () => subscription.ping(),
          unsubscribe: () => subscription.unsubscribe(),
          [Symbol.dispose]: () => subscription.unsubscribe(),
        };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internals.
  // ---------------------------------------------------------------------------

  #readIdentity(): ProcessorFacetIdentity | undefined {
    return this.ctx.storage.kv.get<ProcessorFacetIdentity>(FACET_IDENTITY_KEY);
  }

  #requireIdentity(): ProcessorFacetIdentity {
    const identity = this.#readIdentity();
    if (!identity) {
      throw new Error("ProcessorFacet has no stashed identity yet — call configure() first");
    }
    return identity;
  }

  #requireHost(): { registry: StreamProcessorRegistry } {
    if (!this.#host) {
      const identity = this.#requireIdentity();
      const host = this.createHost(identity);
      const registry = createStreamProcessorRegistry(
        // The alarm facade re-reads the stashed identity PER CALL (see
        // facetProcessorDurableObjectState): recovery's boot reconcile dials
        // it during this very construction.
        facetProcessorDurableObjectState(this.ctx, () =>
          this.parentAlarms(this.#requireIdentity()),
        ),
        {
          stream: host.stream,
          path: identity.path,
          projectId: identity.projectId,
          version: host.version,
          ...(!host.now ? {} : { now: host.now }),
          ...(!host.getLiveState ? {} : { getLiveState: host.getLiveState }),
        },
      );
      host.registerProcessors(registry);
      this.#host = { registry };
    }
    return this.#host;
  }

  #reads(name: string | undefined) {
    const { registry } = this.#requireHost();
    if (name) return registry.reads(name);
    const names = registry.names;
    if (names.length === 1) return registry.reads(names[0]!);
    throw new Error(
      `this facet hosts ${names.length} processors (${names.join(", ") || "none"}); pass a name`,
    );
  }
}
