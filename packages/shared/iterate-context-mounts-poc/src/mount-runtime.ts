import type { WorkerLoader } from "cloudflare:workers";
import { compileMountWorkerModule } from "./mount-worker-compiler.ts";
import type { IterateContextProps, MountSpec } from "./types.ts";

type MountWorkerEntrypoint = {
  invoke(input: { exportName: string; path: string[]; args: unknown[] }): Promise<unknown>;
  dispatch(input: { exportName: string; path: string[]; args: unknown[] }): Promise<unknown>;
} & Partial<Disposable>;

export type MountRuntime = {
  call(mount: MountSpec, path: string[], args: unknown[]): Promise<unknown>;
};

export function createMountRuntime(input: {
  loader: WorkerLoader;
  props: IterateContextProps;
  getIterateStub: () => unknown;
}): MountRuntime {
  const workerCache = new Map<string, MountWorkerEntrypoint>();

  function loadWorker(workerName: string): MountWorkerEntrypoint {
    const cached = workerCache.get(workerName);
    if (cached) return cached;

    const spec = input.props.workers?.[workerName];
    if (!spec) {
      throw new Error(`Unknown mount worker: ${workerName}`);
    }

    const stub = input.loader
      .load({
        compatibilityDate: "2026-04-27",
        compatibilityFlags: [],
        mainModule: "mount-worker.js",
        modules: {
          "mount-worker.js": compileMountWorkerModule(spec.source),
        },
        env: {
          ITERATE: input.getIterateStub(),
        },
      })
      .getEntrypoint() as unknown as MountWorkerEntrypoint;

    workerCache.set(workerName, stub);
    return stub;
  }

  return {
    async call(mount, path, args) {
      if (!("worker" in mount.target)) {
        throw new Error(`Mount ${mount.name} must target a worker.`);
      }

      const worker = loadWorker(mount.target.worker);
      if (mount.mode === "path-dispatch") {
        return await worker.dispatch({
          exportName: mount.target.exportName,
          path,
          args,
        });
      }

      return await worker.invoke({
        exportName: mount.target.exportName,
        path,
        args,
      });
    },
  };
}
