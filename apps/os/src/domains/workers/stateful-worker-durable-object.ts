import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { StatefulDynamicWorkerRef } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { invokePreferringFlattenedPath, replayPath } from "../capability-host/live-capability.ts";
import { takeWorkerFetchDispatch } from "./worker-fetch-dispatch.ts";
import { DynamicWorkerRunner } from "./worker-runner.ts";

const FACET_NAME = "target";
const VERSION_STORAGE_KEY = "workers:stateful-worker-version";

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
  // The hosted Durable Object class sees the same scoped ITX binding as a
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
    const facet = await this.#facet(taken.dispatch.ref, taken.dispatch.buildBudgetMs);
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

  async #facet(ref: StatefulDynamicWorkerRef, buildBudgetMs?: number): Promise<unknown> {
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
