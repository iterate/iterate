import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { StatefulDynamicWorkerRef } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  itxEntrypointBinding,
  itxEntrypointProps,
  itxEntrypointScopeCacheKey,
} from "../itx/utils.ts";
import { invokeFlattenedPath, replayPath } from "../itx/live-capability.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { DynamicWorkerRunner } from "./worker-runner.ts";

const FACET_NAME = "target";
const VERSION_STORAGE_KEY = "workers:stateful-worker-version";

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
  readonly #itxScope = itxEntrypointProps({
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #workerRunner = new DynamicWorkerRunner({
    bindings: {
      // The hosted Durable Object class sees the same scoped ITX binding as a
      // stateless worker at this path. That is what lets a provided durable
      // capability call sibling capabilities through `this.env.ITX.get()`.
      ITX: itxEntrypointBinding(this.ctx.exports, this.#itxScope),
    },
    globalOutbound: projectEgressFetcher(this.ctx.exports, this.#name.projectId),
    loader: this.env.LOADER,
    projectId: this.#name.projectId,
    workerScopeKey: itxEntrypointScopeCacheKey(this.#itxScope),
  });

  async invokeCapability({
    args = [],
    flattenNestedPath = false,
    path,
    ref,
  }: {
    args?: unknown[];
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
    const target = await this.#facet(ref);
    return flattenNestedPath
      ? await invokeFlattenedPath({ args, path, target })
      : await replayPath({ args, path, target });
  }

  async #facet(ref: StatefulDynamicWorkerRef): Promise<unknown> {
    this.#assertRefMatchesName(ref);
    // DynamicWorkerRef is a deliberately late-bound recipe. Repo-backed refs should see
    // source changes on next use, and inline refs are loaded only when someone
    // actually calls the capability. That laziness is what keeps
    // `provideCapability()` a pure stream append instead of a half-commit that
    // might also create/abort facet state.
    const { klass, resolved } = await this.#workerRunner.loadStatefulClass(ref);
    const version = JSON.stringify({
      className: ref.className,
      sourceCacheKey: resolved.cacheKey,
    });

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
