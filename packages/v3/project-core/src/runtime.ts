import * as workers from "cloudflare:workers";
import { z } from "zod";
import { Fault, methodPath, ModulesSchema, type Source } from "./model.ts";
import { sha256 } from "./encoding.ts";
import { WorkerTarget } from "./types.ts";
import { canonical } from "./signatures.ts";

type RuntimeWorkers = typeof workers & {
  RpcPromise: abstract new (...args: never[]) => Disposable;
  RpcProperty: abstract new (...args: never[]) => object;
};

// workerd exports these pipeline brands, but workers-types has not declared them yet.
// This narrow bridge avoids treating arbitrary thenables as pipelinable RPC values.
const { RpcPromise, RpcProperty } = workers as unknown as RuntimeWorkers;

type LoadOptions = {
  env: { LOADER: WorkerLoader; VERSION: { id: string } };
  owner: string;
  host: Fetcher;
  next?: Fetcher;
  cache?: false;
};

/** Dynamic entrypoints cannot transfer; this session-scoped target keeps execution at its owner. */
export class LoadedWorker extends WorkerTarget {
  #worker?: WorkerStub;
  constructor(
    worker: WorkerStub,
    readonly exportName?: string,
  ) {
    super();
    this.#worker = worker;
  }
  get #entrypoint() {
    if (!this.#worker) throw new Fault("WORKER_CLOSED", "Worker handle disposed", 410);
    return this.#worker.getEntrypoint(this.exportName);
  }
  override invoke(path: readonly string[], ...args: unknown[]) {
    return callTarget(this.#entrypoint, path, args);
  }
  override fetch(request: Request) {
    return this.#entrypoint.fetch(request);
  }
  override [Symbol.dispose]() {
    this.#worker = undefined;
  }
}

/** Native workerd validates WorkerCode; this adapter owns only the injected authority. */
export function loadWorker(value: unknown, options: LoadOptions, revision?: string): WorkerStub {
  const input = z.looseObject({ env: z.record(z.string(), z.unknown()).optional() }).parse(value);
  // Native load/get validate the remaining native fields; duplicating their schema would drift.
  const code = {
    ...input,
    env: { ...input.env, ITX: options.host, ...(options.next && { NEXT: options.next }) },
    globalOutbound: options.host,
  } as WorkerLoaderWorkerCode;
  return revision && options.cache !== false
    ? options.env.LOADER.get(
        JSON.stringify([options.env.VERSION.id, options.owner, revision]),
        () => code,
      )
    : options.env.LOADER.load(code);
}

function pipelined(value: unknown): value is object {
  return value instanceof RpcPromise || value instanceof RpcProperty;
}

/** The source adapter supplies a stable identity; only Worker Loader retains cached isolates. */
export async function loadSource(
  source: Source,
  options: LoadOptions & {
    filesForRepo: (
      repo: string,
      revision: string,
    ) => Record<string, string> | Promise<Record<string, string>>;
  },
): Promise<WorkerStub> {
  // Repos know files; this adapter validates executable modules and snapshots before hashing.
  const modules = {
    ...("modules" in source
      ? source.modules
      : ModulesSchema.parse(await options.filesForRepo(source.repo, source.revision))),
  };
  const revision = "modules" in source ? await sha256(canonical(modules)) : source.revision;
  return loadWorker(
    {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      mainModule: "main.js",
      modules,
    },
    options,
    revision,
  );
}

/** Resolve and call one explicit member path without inventing a durable expression language. */
export async function callTarget(
  target: unknown,
  path: readonly string[],
  args: unknown[],
): Promise<unknown> {
  methodPath(path);
  let value = target;
  let receiver: unknown;
  for (const member of path) {
    if (member in Object.prototype) throw new Fault("METHOD", "Reserved method path");
    if (!pipelined(value)) value = await value;
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
      throw new Fault("METHOD", `Cannot read ${member} from ${String(value)}`);
    receiver = value;
    value = Reflect.get(value, member);
  }
  if (typeof value !== "function") throw new Fault("METHOD", `${path.at(-1)} is not callable`);
  const result = Reflect.apply(value, receiver, args);
  try {
    return await result;
  } catch (error) {
    // Failed native RPC promises can retain their session pipeline. Release only our rejected
    // call; disposing on success would revoke capabilities returned to the caller.
    if (result instanceof RpcPromise) result[Symbol.dispose]();
    throw error;
  }
}
