import type { IterateContextCapability } from "./iterate-context.ts";
import { buildMountIndex } from "./mount-index.ts";
import type { MountSpec } from "./types.ts";

/**
 * Local authoring proxy: dynamic property access becomes callMounted().
 * This is the codemode ergonomics layer described in iterate-context.md.
 */
export function createLocalCtxProxy(ctx: IterateContextCapability, mounts: MountSpec[] = []) {
  const index = buildMountIndex(mounts);

  function createPathProxy(basePath: string[]): object {
    const callable = async (...args: unknown[]) => ctx.callMounted(basePath, args);
    return new Proxy(callable, {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (typeof prop !== "string") return undefined;
        return createPathProxy([...basePath, prop]);
      },
    });
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (typeof prop !== "string") return undefined;

        const builtin = Reflect.get(ctx as object, prop, ctx);
        if (builtin !== undefined) {
          return typeof builtin === "function" ? builtin.bind(ctx) : builtin;
        }

        if (index.functions.has(prop)) {
          return (...args: unknown[]) => ctx.callMounted([prop], args);
        }

        if (index.objects.has(prop) || index.pathDispatch.some((mount) => mount.path[0] === prop)) {
          return createPathProxy([prop]);
        }

        return undefined;
      },
    },
  ) as IterateContextCapability & Record<string, unknown>;
}
