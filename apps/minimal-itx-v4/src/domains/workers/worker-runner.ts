import { env } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { replayPath } from "../itx/live-capability.ts";
import { loadResolvedWorker, resolveWorkerSource, type WorkerBindings } from "./worker-loader.ts";
import type { StatefulWorkerRef, StatelessWorkerRef, WorkerRef } from "./types.ts";

type StatefulWorkerRpc = {
  get(ref: StatefulWorkerRef): Promise<unknown>;
  invokeCapability(input: {
    args?: unknown[];
    path: string[];
    ref: StatefulWorkerRef;
  }): Promise<unknown>;
  validate(ref: StatefulWorkerRef): Promise<void>;
};

export class WorkerRunner {
  readonly #bindings: WorkerBindings;
  readonly #loader: Env["LOADER"];
  readonly #projectId: string;
  readonly #workerScopeKey: string;

  constructor(props: {
    bindings: WorkerBindings;
    loader: Env["LOADER"];
    projectId: string;
    workerScopeKey: string;
  }) {
    this.#bindings = props.bindings;
    this.#loader = props.loader;
    this.#projectId = props.projectId;
    this.#workerScopeKey = props.workerScopeKey;
  }

  async get<T = unknown>(ref: WorkerRef): Promise<T> {
    if (ref.type === "stateful") {
      return (await this.#statefulWorker(ref).get(ref)) as T;
    }
    return (await this.#getStateless(ref)) as T;
  }

  async validate(ref: WorkerRef): Promise<void> {
    if (ref.type === "stateful") {
      await this.#statefulWorker(ref).validate(ref);
      return;
    }

    await this.#getStateless(ref);
  }

  async invokeCapability({
    args = [],
    path,
    ref,
  }: {
    args?: unknown[];
    path: string[];
    ref: WorkerRef;
  }): Promise<unknown> {
    if (ref.type === "stateful") {
      return await this.#statefulWorker(ref).invokeCapability({ args, path, ref });
    }

    return await replayPath({
      args,
      path,
      target: await this.#getStateless(ref),
    });
  }

  async #getStateless(ref: StatelessWorkerRef): Promise<unknown> {
    const resolved = await resolveWorkerSource({
      projectId: this.#projectId,
      source: ref.source,
    });
    const worker = loadResolvedWorker({
      bindings: this.#bindings,
      loader: this.#loader,
      projectId: this.#projectId,
      ref,
      resolved,
      workerScopeKey: this.#workerScopeKey,
    });
    return worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} });
  }

  #statefulWorker(ref: StatefulWorkerRef): StatefulWorkerRpc {
    return env.WORKER.getByName(
      statefulWorkerDurableObjectName(this.#projectId, ref),
    ) as unknown as StatefulWorkerRpc;
  }
}

export function statefulWorkerDurableObjectName(projectId: string, ref: StatefulWorkerRef): string {
  return DurableObjectNameCodec.stringify({
    projectId,
    path: ref.path,
    props: {
      durableWorkerKey: ref.durableWorkerKey,
    },
  });
}
