import { RpcTarget } from "cloudflare:workers";
import { ProjectCapability, StreamsCapability } from "./baked-in.ts";
import { buildMountIndex, findPathDispatchMount, type MountIndex } from "./mount-index.ts";
import { createMountRuntime, type MountRuntime } from "./mount-runtime.ts";
import type { IterateContextProps, MountSpec } from "./types.ts";

export type IterateContextHostEnv = {
  LOADER: WorkerLoader;
};

export class IterateContextCapability extends RpcTarget {
  readonly #index: MountIndex;
  readonly #mountRuntime: MountRuntime;
  readonly #streams: StreamsCapability;
  readonly #project: ProjectCapability;

  constructor(input: {
    index: MountIndex;
    mountRuntime: MountRuntime;
    mounts: MountSpec[];
    streams: StreamsCapability;
    project: ProjectCapability;
  }) {
    super();
    this.#index = input.index;
    this.#mountRuntime = input.mountRuntime;
    this.#streams = input.streams;
    this.#project = input.project;
    installMountedMethods(this, input.mounts);
  }

  get streams() {
    return this.#streams;
  }

  get project() {
    return this.#project;
  }

  async callMounted(path: string[], args: unknown[] = []) {
    if (path.length === 0) {
      throw new Error("callMounted requires a non-empty path");
    }

    const builtin = this.#builtin(path);
    if (builtin) return this.#callOnCapability(builtin.target, builtin.path, args);

    const functionMount = path.length === 1 ? this.#index.functions.get(path[0]!) : undefined;
    if (functionMount) return await this.#mountRuntime.call(functionMount, [], args);

    const objectMount = this.#index.objects.get(path[0]!);
    if (objectMount && path.length > 1) {
      return await this.#mountRuntime.call(objectMount, path.slice(1), args);
    }

    const dispatch = findPathDispatchMount(this.#index, path);
    if (dispatch) {
      return await this.#mountRuntime.call(dispatch.mount, dispatch.remainder, args);
    }

    throw new Error(`No mount registered for path: ${path.join(".")}`);
  }

  async getMounted(path: string[]) {
    if (path.length === 0) {
      throw new Error("getMounted requires a non-empty path");
    }

    const builtin = this.#builtin(path);
    if (builtin) return this.#callOnCapability(builtin.target, builtin.path, []);

    const objectMount = this.#index.objects.get(path[0]!);
    if (!objectMount) {
      throw new Error(`No object mount registered for path: ${path.join(".")}`);
    }

    return await this.#mountRuntime.call(objectMount, path.slice(1), []);
  }

  #builtin(path: string[]) {
    const target =
      path[0] === "project" ? this.#project : path[0] === "streams" ? this.#streams : undefined;
    if (target) return { target, path: path.slice(1) };

    const mount = this.#index.builtins.get(path.join("\0"));
    if (!mount || !("capability" in mount.target)) return null;

    switch (mount.target.capability) {
      case "project":
        return { target: this.#project, path: path.slice(1) };
      case "streams":
        return { target: this.#streams, path: path.slice(1) };
      case "repos":
      case "workspaces":
        throw new Error(`Builtin capability not implemented in POC: ${mount.target.capability}`);
    }
  }

  #callOnCapability(target: RpcTarget, path: string[], args: unknown[]) {
    if (path.length === 0) return target;

    let current: unknown = target;
    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i]!;
      if (current == null || typeof current !== "object") {
        throw new Error(`Capability path not found: ${path.join(".")}`);
      }
      current = (current as Record<string, unknown>)[segment];
      if (typeof current === "function") {
        current = (current as (...innerArgs: unknown[]) => unknown).call(target);
      }
    }
    const methodName = path[path.length - 1]!;
    if (current == null || typeof current !== "object") {
      throw new Error(`Capability path not found: ${path.join(".")}`);
    }
    const method = (current as Record<string, unknown>)[methodName];
    if (typeof method !== "function") {
      throw new Error(`Capability method not found: ${path.join(".")}`);
    }
    return method.apply(current, args);
  }
}

export function createIterateContext(input: {
  loader: WorkerLoader;
  props: IterateContextProps;
  getIterateStub: () => { getIterateContext(): IterateContextCapability };
}) {
  const index = buildMountIndex(input.props.mounts);
  const streams = new StreamsCapability();
  const project = new ProjectCapability(input.props.projectId ?? "proj_demo");

  const mountRuntime = createMountRuntime({
    loader: input.loader,
    props: input.props,
    getIterateStub: input.getIterateStub,
  });

  return new IterateContextCapability({
    index,
    mountRuntime,
    mounts: input.props.mounts ?? [],
    streams,
    project,
  });
}

function installMountedMethods(target: IterateContextCapability, mounts: MountSpec[]) {
  const methods = mounts.filter((mount) => mount.mode === "function" && mount.path.length === 1);
  if (methods.length === 0) return;

  const instancePrototype = Object.create(Object.getPrototypeOf(target)) as object;

  for (const mount of methods) {
    const methodName = mount.path[0]!;

    Object.defineProperty(instancePrototype, methodName, {
      value: async function callMountedFunction(
        this: IterateContextCapability,
        ...args: unknown[]
      ) {
        return await this.callMounted([methodName], args);
      },
      writable: false,
      configurable: true,
    });
  }

  Object.setPrototypeOf(target, instancePrototype);
}
