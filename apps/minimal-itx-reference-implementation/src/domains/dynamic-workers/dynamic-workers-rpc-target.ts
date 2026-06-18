import { env as workerEnv, RpcTarget } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { localPathProxy } from "../../itx/path-invoker.ts";
import { formatDurableObjectName } from "../durable-object-names.ts";
import type { DynamicWorkerRef, DynamicWorkerSourceRef } from "./dynamic-worker-ref.ts";
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

  constructor(input: {
    bindings: WorkerBindings;
    facets: DurableObjectState["facets"];
    loader: Env["LOADER"];
    projectId: string;
    storage: DurableObjectStorage;
  }) {
    super();
    this.#bindings = input.bindings;
    this.#facets = input.facets;
    this.#loader = input.loader;
    this.#projectId = input.projectId;
    this.#storage = input.storage;
  }

  get(ref: DynamicWorkerRef): unknown {
    return localPathProxy(this.#resolve(ref));
  }

  async #resolve(ref: DynamicWorkerRef): Promise<unknown> {
    if (ref.type === "worker-entrypoint") {
      const worker = await this.#loadWorker(ref);
      return worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} });
    }
    return await this.#getDurableObjectFacet(ref);
  }

  async #getDurableObjectFacet(ref: Extract<DynamicWorkerRef, { type: "durable-object" }>) {
    const resolved = await this.#resolveSource(ref.source);
    const worker = this.#loadResolvedWorker({ ref, resolved });
    const klass = worker.getDurableObjectClass?.(ref.className);
    if (!klass) throw new Error(`Dynamic worker did not export DurableObject ${ref.className}.`);

    const stableFacetKey = ref.cacheKey ?? `source:${resolved.cacheKey}:class:${ref.className}`;
    const facetName = `durable-object-facet:${hashString(
      JSON.stringify({ projectId: this.#projectId, stableFacetKey }),
    )}`;
    const version = JSON.stringify({
      className: ref.className,
      sourceCacheKey: resolved.cacheKey,
    });
    const versionKey = `itx:dynamic-do-facet-version:${facetName}`;
    const previous = (await this.#storage.get(versionKey)) as string | undefined;

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

  async #resolveSource(source: DynamicWorkerSourceRef): Promise<ResolvedWorkerSource> {
    if (source.type === "inline") {
      return {
        cacheKey: hashString(JSON.stringify(source)),
        mainModule: source.mainModule,
        modules: source.modules,
      };
    }

    const repo = workerEnv.REPO.getByName(
      formatDurableObjectName({
        projectId: this.#projectId,
        path: source.repoPath,
      }),
    );
    const resolved = await repo.getWorkerSource({ path: source.sourcePath });
    return {
      cacheKey: hashString(JSON.stringify({ source, resolved })),
      mainModule: resolved.mainModule,
      modules: resolved.modules,
    };
  }
}
