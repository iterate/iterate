import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { itxEntrypointScopeCacheKey, scopedItxEntrypointProps } from "../itx/entrypoint-props.ts";
import { replayPath } from "../itx/live-capability.ts";
import { loadResolvedWorker, resolveWorkerSource } from "./worker-loader.ts";
import type { StatefulWorkerRef } from "./types.ts";

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
  readonly #itxScope = scopedItxEntrypointProps({
    path: this.#name.path,
    projectId: this.#name.projectId,
  });

  async validate(ref: StatefulWorkerRef): Promise<void> {
    await this.#facet(ref);
  }

  async get(ref: StatefulWorkerRef): Promise<unknown> {
    return await this.#facet(ref);
  }

  async invokeCapability({
    args = [],
    path,
    ref,
  }: {
    args?: unknown[];
    path: string[];
    ref: StatefulWorkerRef;
  }) {
    return await replayPath({
      args,
      path,
      target: await this.#facet(ref),
    });
  }

  async #facet(ref: StatefulWorkerRef): Promise<unknown> {
    this.#assertRefMatchesName(ref);
    const resolved = await resolveWorkerSource({
      projectId: this.#name.projectId,
      source: ref.source,
    });
    const worker = loadResolvedWorker({
      bindings: {
        // The hosted Durable Object class sees the same scoped ITX binding as a
        // stateless worker at this path. That is what lets a provided durable
        // capability call sibling capabilities through `this.env.ITX.get()`.
        ITX: this.ctx.exports.ItxEntrypoint({ props: this.#itxScope }),
      },
      loader: this.env.LOADER,
      projectId: this.#name.projectId,
      ref,
      resolved,
      workerScopeKey: itxEntrypointScopeCacheKey(this.#itxScope),
    });
    const klass = worker.getDurableObjectClass?.(ref.className);
    if (!klass) {
      throw new Error(`Worker source did not export DurableObject ${ref.className}.`);
    }
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

  #assertRefMatchesName(ref: StatefulWorkerRef) {
    const durableWorkerKey = this.#name.props.durableWorkerKey;
    if (durableWorkerKey === undefined) {
      throw new Error("Stateful worker Durable Object name requires durableWorkerKey query prop.");
    }
    if (ref.path !== this.#name.path || ref.durableWorkerKey !== durableWorkerKey) {
      throw new Error(
        `Stateful worker ref ${ref.path}?durableWorkerKey=${ref.durableWorkerKey} does not match Durable Object ${this.#name.durableObjectName}.`,
      );
    }
  }
}
