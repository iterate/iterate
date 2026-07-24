import { DurableObject, tracing } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  invokeFlattenedPath,
  invokePreferringFlattenedPath,
  isMissingInvokeCapabilityError,
  replayPath,
} from "../capability-host/live-capability.ts";
import { workerBuildFailedError, type WorkerBuildFailure } from "./artifact-store.ts";
import { takeWorkerFetchDispatch, workerBuildStatus } from "./worker-fetch-dispatch.ts";
import type { StatefulDynamicWorkerRef } from "./schemas.ts";
import { withWorkerCommit } from "./worker-serve-info.ts";
import { workerBuildFailedResponse } from "./worker-serve-overlay.ts";
import { DynamicWorkerRunner } from "./worker-runner.ts";

const FACET_NAME = "target";
const VERSION_STORAGE_KEY = "workers:stateful-worker-version";

/** The worker ref to boot when an alarm fires on a cold outer DO — the
 * same late-bound resolution every invocation does. Every arm rewrites it
 * with the caller's current ref, so fires converge on current source. */
const ALARM_REF_STORAGE_KEY = "workers:stateful-worker-alarm-ref";

/** The durable marker for which build this facet is running. */
function statefulWorkerVersion(ref: StatefulDynamicWorkerRef, sourceCacheKey: string): string {
  return JSON.stringify({ className: ref.className, sourceCacheKey });
}

/**
 * Hosts one stateful dynamic worker facet.
 *
 * The outer DO owns durable identity and Cloudflare storage. The inner facet is
 * the Durable Object class exported by the dynamic worker source. We keep one
 * stable facet name (`target`) so source changes do not create a new storage
 * identity; instead the facet is aborted and re-created against the same DO.
 */
export class StatefulWorkerDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  // The hosted Durable Object class sees the same scoped itx binding as a
  // stateless worker at this path. That is what lets a provided durable
  // capability call sibling capabilities through `this.env.ITX.get()`.
  readonly #workerRunner = new DynamicWorkerRunner({
    streamContext: { kind: "scope", scopePath: this.#name.path },
    exports: this.ctx.exports,
    projectId: this.#name.projectId,
    scopePath: this.#name.path,
  });

  /**
   * The fetch-native lane into the hosted facet — how WebSocket upgrades (and
   * streaming fetch generally) reach a stateful dynamic worker. A Durable
   * Object fetch handler has no argument channel besides the request, so the
   * ref rides in the internal dispatch header (set by
   * DynamicWorkerRunner.fetch). The facet stub's own `fetch` tunnels the
   * upgrade natively, which method replay through invokeCapability cannot.
   */
  async fetch(request: Request): Promise<Response> {
    const taken = takeWorkerFetchDispatch(request);
    if (taken === null) {
      return new Response("stateful worker fetch requires the worker dispatch header", {
        status: 400,
      });
    }
    const ref = taken.dispatch.ref;
    if (ref.type !== "stateful") {
      throw new Error("StatefulWorkerDurableObject.fetch dispatched with a non-stateful ref.");
    }
    let loaded:
      | { commitOid?: string; ok: true; target: unknown }
      | { failure: WorkerBuildFailure; ok: false };
    try {
      loaded = await tracing.enterSpan(
        "dynamic_worker.stateful.resolve_facet",
        async () => await this.#facet(ref, taken.dispatch.buildBudgetMs),
      );
    } catch (error) {
      // Answer exceptional build states HERE rather than relying on an error
      // name surviving the Durable Object fetch hop back to the dispatching
      // entrypoint — same pages every fetch-lane hop serves.
      const buildStatus = workerBuildStatus(
        error,
        taken.request.headers.get("x-iterate-url-prefix") ?? "",
      );
      if (buildStatus !== null) return buildStatus.response;
      throw error;
    }
    if (!loaded.ok) {
      return workerBuildFailedResponse(
        loaded.failure.message,
        taken.request.headers.get("x-iterate-url-prefix") ?? "",
      );
    }
    return await tracing.enterSpan("dynamic_worker.stateful.target_fetch", async (span) => {
      const response = withWorkerCommit(
        await (loaded.target as Fetcher).fetch(taken.request),
        loaded.commitOid,
      );
      span.setAttribute("http.response.status_code", response.status);
      return response;
    });
  }

  async invokeCapability({
    args = [],
    buildBudgetMs,
    flattenNestedPath = false,
    path,
    ref,
  }: {
    args?: unknown[];
    buildBudgetMs?: number;
    flattenNestedPath?: boolean;
    path: string[];
    ref: StatefulDynamicWorkerRef;
  }) {
    // This method is intentionally the only public runtime entrypoint for the
    // hosted facet. We do not expose `validate(ref)` or `get(ref)`: validation at
    // provide-time made "store this worker ref" mutate facet storage before
    // the stream commit, and returning facet stubs across this extra DO boundary
    // was the source of opaque RPC failures. Keeping invocation here makes the
    // ownership boundary boring: the outer DO receives a call, resolves the
    // current ref, restarts the facet if the source changed, and performs the
    // method replay without leaking the inner facet reference.
    const loaded = await this.#facet(ref, buildBudgetMs);
    if (!loaded.ok) return loaded;
    const value = flattenNestedPath
      ? await invokePreferringFlattenedPath({ args, path, target: loaded.target })
      : await replayPath({ args, path, target: loaded.target });
    return { ok: true as const, value };
  }

  /**
   * The hosted facet's durable alarm, owned HERE because workerd does not
   * implement alarms for facets (their storage hooks throw "alarms are not
   * yet implemented for SQLite-backed Durable Objects"; workerd#6810). This
   * outer DO is a root actor, so its real platform alarm IS the facet's
   * alarm — these verbs guard it, and the only extra state is the worker
   * ref to boot when a fire lands cold. Everything behavioral is the
   * native runtime's, inherited rather than reimplemented: consume on
   * success, retry with backoff on a throwing handler (this handler
   * rethrows), and getAlarm()'s during-a-fire view. `iterate/sdk`'s
   * `IterateDurableObject` presents this as the standard `ctx.storage` alarm
   * API, self-addressed through the ref this host delivers on first contact
   * (see `#facet`'s identity delivery).
   */
  async setAlarm({ atMs, ref }: { atMs: number | null; ref: StatefulDynamicWorkerRef }) {
    this.#assertRefMatchesName(ref);
    if (atMs === null) {
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.kv.delete(ALARM_REF_STORAGE_KEY);
      return;
    }
    // Platform alarm first: if arming throws, nothing was persisted and
    // getAlarm() keeps telling the truth. No interleave risk — storage
    // awaits hold the Durable Object's input gate.
    await this.ctx.storage.setAlarm(atMs);
    this.ctx.storage.kv.put(ALARM_REF_STORAGE_KEY, ref);
  }

  getAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const ref = this.ctx.storage.kv.get<StatefulDynamicWorkerRef>(ALARM_REF_STORAGE_KEY);
    // No armed ref (disarmed after the fire was scheduled) — a stray
    // platform fire is a no-op.
    if (ref === undefined) return;
    // Plain copy: AlarmInvocationInfo is a host object and does not
    // serialize across the facet RPC hop (DataCloneError).
    const info =
      alarmInfo === undefined
        ? undefined
        : { isRetry: alarmInfo.isRetry, retryCount: alarmInfo.retryCount };
    const loaded = await this.#facet(ref);
    if (!loaded.ok) throw workerBuildFailedError(loaded.failure);
    try {
      // Flattened on purpose: workerd reserves `alarm` as an RPC method name
      // on Durable Object stubs, so the fire rides the worker's own
      // `invokeCapability` dispatcher, whose userland walk calls the class's
      // `alarm()` locally — where the name is ordinary. Failures rethrow
      // into the platform's native alarm retry.
      await invokeFlattenedPath({ args: [info], path: ["alarm"], target: loaded.target });
    } catch (error) {
      if (isMissingInvokeCapabilityError(error)) {
        throw new Error(
          `Stateful worker class "${ref.className}" cannot receive alarm fires: it does not ` +
            `expose invokeCapability — extend IterateDurableObject from iterate/sdk. (workerd ` +
            `reserves "alarm" as an RPC name, so fires are delivered through that dispatcher.)`,
        );
      }
      throw error;
    }
  }

  /** Abort the hosted facet and current outer Durable Object incarnation. */
  kill(): void {
    try {
      this.ctx.facets.abort(FACET_NAME, `kill requested for ${this.ctx.id.name}`);
    } catch (error) {
      console.warn(`stateful worker facet kill skipped for ${this.ctx.id.name}`, error);
    }
    this.ctx.abort("kill requested");
  }

  /** The (build version, ref) whose identity this incarnation already
   * delivered — re-delivered when either changes, so stashed inline source
   * converges on current source and a rebuilt class that newly accepts
   * identity gets it without waiting for an eviction. */
  #identityDelivered: string | undefined;

  async #facet(
    ref: StatefulDynamicWorkerRef,
    buildBudgetMs?: number,
  ): Promise<
    { commitOid?: string; ok: true; target: unknown } | { failure: WorkerBuildFailure; ok: false }
  > {
    this.#assertRefMatchesName(ref);
    const loaded = await this.#workerRunner.loadStatefulClass(ref, buildBudgetMs);
    if (!loaded.ok) return loaded;
    const { klass, resolved } = loaded;
    const version = statefulWorkerVersion(ref, resolved.cacheKey);
    const previous = this.ctx.storage.kv.get<string>(VERSION_STORAGE_KEY);
    if (previous && previous !== version) {
      this.ctx.facets.abort(FACET_NAME, `stateful worker source changed for ${this.ctx.id.name}`);
    }
    if (previous !== version) this.ctx.storage.kv.put(VERSION_STORAGE_KEY, version);
    const target = this.ctx.facets.get(FACET_NAME, () => ({ class: klass }));

    // A facet cannot learn its own ref through ctx.facets.get(), so offer it
    // once before traffic. Plain DurableObject classes may omit this SDK door.
    const identity = `${version}\n${JSON.stringify(ref)}`;
    if (this.#identityDelivered !== identity) {
      try {
        await invokeFlattenedPath({ args: [ref], path: ["__stashSelfRef"], target });
        this.#identityDelivered = identity;
      } catch (error) {
        const cannotAcceptIdentity =
          isMissingInvokeCapabilityError(error) ||
          (error instanceof Error && error.message.includes('"__stashSelfRef" is not a method'));
        if (cannotAcceptIdentity) this.#identityDelivered = identity;
      }
    }

    return {
      ...(resolved.commitOid === undefined ? {} : { commitOid: resolved.commitOid }),
      ok: true,
      target,
    };
  }

  #assertRefMatchesName(ref: StatefulDynamicWorkerRef) {
    const durableWorkerKey = this.#name.props.durableWorkerKey;
    if (durableWorkerKey === undefined) {
      throw new Error("Stateful worker Durable Object name requires durableWorkerKey query prop.");
    }
    if (ref.path !== this.#name.path || ref.durableWorkerKey !== durableWorkerKey) {
      throw new Error(
        `Stateful worker ref ${ref.path}?durableWorkerKey=${ref.durableWorkerKey} does not match Durable Object ${this.ctx.id.name}.`,
      );
    }
  }
}
