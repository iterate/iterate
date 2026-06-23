import { env, RpcTarget } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerRef, DynamicWorkerSource } from "./dynamic-worker-ref.ts";
import {
  hashString,
  type ResolvedWorkerSource,
  WORKER_COMPATIBILITY_DATE,
} from "./dynamic-worker-loader.ts";

type WorkerBindings = Record<string, unknown>;

export class DynamicWorkersRpcTarget extends RpcTarget {
  #bindings: WorkerBindings;
  #facets: DurableObjectState["facets"];
  #loader: Env["LOADER"];
  #projectId: string;
  #storage: DurableObjectStorage;

  constructor(props: {
    bindings: WorkerBindings;
    facets: DurableObjectState["facets"];
    loader: Env["LOADER"];
    projectId: string;
    storage: DurableObjectStorage;
  }) {
    super();
    this.#bindings = props.bindings;
    this.#facets = props.facets;
    this.#loader = props.loader;
    this.#projectId = props.projectId;
    this.#storage = props.storage;
  }

  get<T = unknown>(ref: DynamicWorkerRef): Promise<T> {
    return this.#resolve(ref) as Promise<T>;
  }

  async #resolve(ref: DynamicWorkerRef): Promise<unknown> {
    if (ref.target.type === "worker-entrypoint") {
      const worker = await this.#loadWorker(ref);
      return worker.getEntrypoint(ref.target.entrypoint, { props: ref.target.props ?? {} });
    }
    return await this.#getDurableObjectFacet(ref);
  }

  async #getDurableObjectFacet(ref: DynamicWorkerRef) {
    if (ref.target.type !== "durable-object") {
      throw new Error(`Dynamic worker target "${ref.target.type}" is not a Durable Object.`);
    }
    const resolved = await this.#resolveSource(ref.source);
    const worker = this.#loadResolvedWorker({ ref, resolved });
    const klass = worker.getDurableObjectClass?.(ref.target.className);
    if (!klass) {
      throw new Error(`Dynamic worker did not export DurableObject ${ref.target.className}.`);
    }

    const stableFacetKey =
      ref.cacheKey ?? `source:${resolved.cacheKey}:class:${ref.target.className}`;
    const facetName = `durable-object-facet:${hashString(
      JSON.stringify({ projectId: this.#projectId, stableFacetKey }),
    )}`;
    const version = JSON.stringify({
      className: ref.target.className,
      sourceCacheKey: resolved.cacheKey,
    });
    const versionKey = `itx:dynamic-do-facet-version:${facetName}`;
    const previous = await this.#storage.get<string>(versionKey);

    if (previous && previous !== version) {
      this.#facets.abort(facetName, `dynamic Durable Object source changed for ${facetName}`);
    }
    if (previous !== version) await this.#storage.put(versionKey, version);

    return this.#facets.get(facetName, () => ({ class: klass }));
  }

  async #loadWorker(ref: DynamicWorkerRef): Promise<WorkerStub> {
    const resolved = await this.#resolveSource(ref.source);
    return this.#loadResolvedWorker({ ref, resolved });
  }

  #loadResolvedWorker({
    ref,
    resolved,
  }: {
    ref: DynamicWorkerRef;
    resolved: ResolvedWorkerSource;
  }): WorkerStub {
    const cacheKey = [
      "worker-loader",
      this.#projectId,
      ref.cacheKey ?? "anonymous",
      resolved.cacheKey,
    ].join(":");
    return this.#loader.get(cacheKey, () => ({
      compatibilityDate: WORKER_COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      env: this.#bindings,
      mainModule: resolved.mainModule,
      modules: resolved.modules,
    }));
  }

  async #resolveSource(source: DynamicWorkerSource): Promise<ResolvedWorkerSource> {
    if (source.type === "inline") {
      return {
        cacheKey: hashString(JSON.stringify(source)),
        mainModule: source.mainModule,
        modules: source.modules,
      };
    }

    const resolved = await env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#projectId,
        path: source.repoPath,
      }),
    ).getWorkerSource({ path: source.sourcePath });

    return {
      ...resolved,
      cacheKey: hashString(
        JSON.stringify({
          repoPath: source.repoPath,
          repoSourceCacheKey: resolved.cacheKey,
          sourcePath: source.sourcePath,
        }),
      ),
    };
  }
}
