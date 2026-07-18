import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  invokeFlattenedPath,
  invokePreferringFlattenedPath,
  isMissingInvokeCapabilityError,
  replayPath,
} from "../capability-host/live-capability.ts";
import { takeWorkerFetchDispatch, workerBuildStatus } from "./worker-fetch-dispatch.ts";
import type { StatefulDynamicWorkerRef } from "./schemas.ts";
import { DynamicWorkerRunner } from "./worker-runner.ts";

const FACET_NAME = "target";
const VERSION_STORAGE_KEY = "workers:stateful-worker-version";
/** The worker recipe to boot when an alarm fires on a cold outer DO — the
 * same late-bound resolution every invocation does. Every arm rewrites it
 * with the caller's current ref, so fires converge on current source. */
const ALARM_REF_STORAGE_KEY = "workers:stateful-worker-alarm-ref";

/** The durable marker for "which build is this facet running": enough to both
 * detect source changes and re-load the exact artifact for stale serving. */
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
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  // The hosted Durable Object class sees the same scoped itx binding as a
  // stateless worker at this path. That is what lets a provided durable
  // capability call sibling capabilities through `this.env.ITX.get()`.
  readonly #workerRunner = new DynamicWorkerRunner({
    exports: this.ctx.exports,
    projectId: this.#name.projectId,
    scopePath: this.#name.path,
    waitUntil: (promise) => this.ctx.waitUntil(promise),
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
    if (taken.dispatch.ref.type !== "stateful") {
      throw new Error("StatefulWorkerDurableObject.fetch dispatched with a non-stateful ref.");
    }
    let facet: unknown;
    try {
      facet = await this.#facet(taken.dispatch.ref, taken.dispatch.buildBudgetMs);
    } catch (error) {
      // Answer the building/failed cases HERE rather than relying on the
      // error name surviving the Durable Object fetch hop back to the
      // dispatching entrypoint — same pages every fetch-lane hop serves.
      const buildStatus = workerBuildStatus(error);
      if (buildStatus !== null) return buildStatus.response;
      throw error;
    }
    return await (facet as Fetcher).fetch(taken.request);
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
    // provide-time made "store this worker recipe" mutate facet storage before
    // the stream commit, and returning facet stubs across this extra DO boundary
    // was the source of opaque RPC failures. Keeping invocation here makes the
    // ownership boundary boring: the outer DO receives a call, resolves the
    // current recipe, restarts the facet if the source changed, and performs the
    // method replay without leaking the inner facet reference.
    const target = await this.#facet(ref, buildBudgetMs);
    return flattenNestedPath
      ? await invokePreferringFlattenedPath({ args, path, target })
      : await replayPath({ args, path, target });
  }

  /**
   * The hosted facet's durable alarm, owned HERE because workerd does not
   * implement alarms for facets (their storage hooks throw "alarms are not
   * yet implemented for SQLite-backed Durable Objects"; workerd#6810). This
   * outer DO is a root actor, so its real platform alarm IS the facet's
   * alarm — these verbs guard it, and the only extra state is the worker
   * recipe to boot when a fire lands cold. Everything behavioral is the
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
    // No armed recipe (disarmed after the fire was scheduled) — a stray
    // platform fire is a no-op.
    if (ref === undefined) return;
    // Plain copy: AlarmInvocationInfo is a host object and does not
    // serialize across the facet RPC hop (DataCloneError).
    const info =
      alarmInfo === undefined
        ? undefined
        : { isRetry: alarmInfo.isRetry, retryCount: alarmInfo.retryCount };
    const target = await this.#facet(ref);
    try {
      // Flattened on purpose: workerd reserves `alarm` as an RPC method name
      // on Durable Object stubs, so the fire rides the worker's own
      // `invokeCapability` dispatcher, whose userland walk calls the class's
      // `alarm()` locally — where the name is ordinary. Failures rethrow
      // into the platform's native alarm retry.
      await invokeFlattenedPath({ args: [info], path: ["alarm"], target });
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
   * delivered — re-delivered when either changes, so a stashed inline recipe
   * converges on current source and a rebuilt class that newly accepts
   * identity gets it without waiting for an eviction. */
  #identityDelivered: string | undefined;

  async #facet(ref: StatefulDynamicWorkerRef, buildBudgetMs?: number): Promise<unknown> {
    const facet = await this.#resolveFacet(ref, buildBudgetMs);
    // A facet cannot learn its own identity (ctx.facets.get has no props
    // channel, worker env is per-isolate) — deliver its ref before any
    // traffic, once per incarnation per ref AND BUILD. The stash is what
    // lets the worker's own code address itself (the SDK's alarm shim dials
    // `itx.workers.get(ref)`, which resolves back to this DO). Marked
    // delivered only on success (or on a class that structurally cannot
    // accept identity), so a TRANSIENT failure retries on the next call
    // instead of silently disabling self-alarms for the incarnation. The
    // version marker in the key is what makes a "cannot accept" verdict
    // expire with the build that earned it: a repo-backed ref's JSON never
    // changes, but a rebuilt source that newly extends IterateDurableObject
    // must get its identity without waiting for this DO's eviction.
    const identity = `${this.ctx.storage.kv.get<string>(VERSION_STORAGE_KEY) ?? ""}\n${JSON.stringify(ref)}`;
    if (this.#identityDelivered !== identity) {
      try {
        await invokeFlattenedPath({ args: [ref], path: ["__stashSelfRef"], target: facet });
        this.#identityDelivered = identity;
      } catch (error) {
        // No dispatcher (plain DurableObject class) or no door (an
        // invokeCapability that doesn't expose __stashSelfRef): this class
        // can never accept identity — stop offering, and never fail the
        // caller's actual invocation over it.
        const cannotAcceptIdentity =
          isMissingInvokeCapabilityError(error) ||
          (error instanceof Error && error.message.includes('"__stashSelfRef" is not a method'));
        if (cannotAcceptIdentity) this.#identityDelivered = identity;
      }
    }
    return facet;
  }

  async #resolveFacet(ref: StatefulDynamicWorkerRef, buildBudgetMs?: number): Promise<unknown> {
    this.#assertRefMatchesName(ref);

    if (ref.updatePolicy === "stale-while-rebuild") {
      const stale = await this.#staleFacet(ref);
      if (stale !== null) return stale;
      // No runnable previous version (first call, or its artifact expired) —
      // fall through to the blocking load below.
    }

    // DynamicWorkerRef is a deliberately late-bound recipe. Repo-backed refs should see
    // source changes on next use, and inline refs are loaded only when someone
    // actually calls the capability. That laziness is what keeps
    // `provideCapability()` a pure stream append instead of a half-commit that
    // might also create/abort facet state.
    const { klass, resolved } = await this.#workerRunner.loadStatefulClass(ref, buildBudgetMs);
    const version = statefulWorkerVersion(ref, resolved.cacheKey);

    // SQLite-backed Durable Objects expose sync KV as `storage.kv`. Avoiding
    // awaited storage calls here keeps the facet version check/update in one DO
    // turn and matches Cloudflare's current guidance for SQLite-backed DOs.
    const previous = this.ctx.storage.kv.get<string>(VERSION_STORAGE_KEY);

    // A budgeted fetch-lane resolve can answer STALE (the loader's last-good
    // fallback while a newer commit builds). A stale class must never abort a
    // running facet, and must never move the version marker to a build this
    // DO didn't just mount: the awaited resolve above is an interleave point,
    // so a concurrent fresh load may already have swapped the facet to newer
    // code — aborting or marker-writing here would downgrade live state (and
    // storage written by newer code) to the old build.
    if (resolved.serveInfo?.status === "stale") {
      if (previous !== undefined && previous !== version) {
        // The durable marker outranks the global last-good pointer: it names
        // a build THIS DO actually ran — newer knowledge whenever the two
        // disagree. Serve it through the stale-while-rebuild path (same
        // artifact load, same interleave guard, background refresh that
        // converges to fresh source) instead of persisting a regressed
        // marker and mounting outranked code over its own storage.
        const viaMarker = await this.#staleFacet(ref);
        if (viaMarker !== null) return viaMarker;
        // The marker's own artifact is gone (expired) — the pointer's class
        // below is the only loadable history left. If the marker moved while
        // we looked, another request is managing the facet; join it.
        if (this.ctx.storage.kv.get<string>(VERSION_STORAGE_KEY) !== previous) {
          return this.ctx.facets.get(FACET_NAME, () => ({ class: klass }));
        }
      }
      let started = false;
      const facet = this.ctx.facets.get(FACET_NAME, () => {
        started = true;
        return { class: klass };
      });
      // Recording the mounted build is honest exactly when this call started
      // the facet on it (first-ever code, or the only loadable history).
      if (started && previous !== version) this.ctx.storage.kv.put(VERSION_STORAGE_KEY, version);
      return facet;
    }

    if (previous && previous !== version) {
      this.ctx.facets.abort(FACET_NAME, `stateful worker source changed for ${this.ctx.id.name}`);
    }
    if (previous !== version) this.ctx.storage.kv.put(VERSION_STORAGE_KEY, version);
    return this.ctx.facets.get(FACET_NAME, () => ({ class: klass }));
  }

  /**
   * The stale-while-rebuild serve path: answer with the version this DO
   * already ran (its artifact is content-addressed and immutable, so loading
   * it never builds), while a background resolve checks for newer source and
   * swaps the facet when the fresh build lands. The availability trade-off is
   * the ref's explicit choice — see `updatePolicy` on the public type.
   */
  async #staleFacet(ref: StatefulDynamicWorkerRef): Promise<unknown | null> {
    const previous = this.ctx.storage.kv.get<string>(VERSION_STORAGE_KEY);
    if (previous === undefined) return null;
    // Self-healing on a malformed marker (legacy format, future schema
    // change): fall through to the blocking load, which rewrites it —
    // throwing here would wedge every stale-while-rebuild call forever.
    let parsed: { className: string; sourceCacheKey: string };
    try {
      parsed = JSON.parse(previous) as { className: string; sourceCacheKey: string };
    } catch {
      return null;
    }
    if (parsed.className !== ref.className) return null;

    const cached = await this.#workerRunner.loadStatefulClassFromCacheKey(
      ref,
      parsed.sourceCacheKey,
    );
    if (cached === null) return null;

    // The KV read above is an interleave point: a background refresh may have
    // completed meanwhile — new version written, facet aborted. Re-creating
    // the facet with OUR (now old) class would wedge the DO on stale code
    // forever (storage says new, facet runs old, nothing ever aborts again).
    // The sync re-read plus facets.get below run in one DO turn, so this
    // check cannot itself be interleaved.
    if (this.ctx.storage.kv.get<string>(VERSION_STORAGE_KEY) !== previous) return null;

    this.#refreshFacetInBackground(ref, previous);
    return this.ctx.facets.get(FACET_NAME, () => ({ class: cached.klass }));
  }

  #refreshInFlight = false;

  #refreshFacetInBackground(ref: StatefulDynamicWorkerRef, previousVersion: string): void {
    if (this.#refreshInFlight) return;
    this.#refreshInFlight = true;
    this.ctx.waitUntil(
      (async () => {
        try {
          const { resolved } = await this.#workerRunner.loadStatefulClass(ref);
          const version = statefulWorkerVersion(ref, resolved.cacheKey);
          if (version === previousVersion) return;
          this.ctx.storage.kv.put(VERSION_STORAGE_KEY, version);
          this.ctx.facets.abort(
            FACET_NAME,
            `stateful worker source changed (stale-while-rebuild) for ${this.ctx.id.name}`,
          );
        } catch (error) {
          // The stale facet keeps serving; the next call retries the refresh.
          console.warn(`stale-while-rebuild refresh failed for ${this.ctx.id.name}`, error);
        } finally {
          this.#refreshInFlight = false;
        }
      })(),
    );
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
