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
    // POC only: local authoring path recorder. Unknown property reads append to
    // basePath; the final function call forwards that path and args to
    // ctx.callMounted(...).
    //
    // Effect:
    //   proxy.tools.echo("hi")
    // calls:
    //   ctx.callMounted(["tools", "echo"], ["hi"])
    //
    // Returning undefined for `then` is mandatory because JavaScript await and
    // Promise resolution probe that property. If this proxy were thenable,
    // `await proxy.tools` would accidentally become a mounted call.
    //
    // References:
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Cap'n Web README: https://github.com/cloudflare/capnweb
    return new Proxy(callable, {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (typeof prop !== "string") return undefined;
        return createPathProxy([...basePath, prop]);
      },
    });
  }

  // POC only: root context overlay. Built-in properties are read from the real
  // IterateContextCapability first. If a root name belongs to a function mount,
  // the proxy returns a function that directly calls ctx.callMounted([root]).
  // If a root name belongs to an object/path-dispatch mount, it returns the
  // path recorder above.
  //
  // This demonstrates the ergonomics we later narrowed in production: built-in
  // roots should remain real RpcTarget/WorkerEntrypoint stubs, and only
  // dynamic/unknown mounted roots need a local path recorder.
  //
  // References:
  // - Dynamic Workers API: https://developers.cloudflare.com/dynamic-workers/api-reference/
  // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
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
