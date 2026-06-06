import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget as CapnWebRpcTarget } from "capnweb";

const rpcReservedNames = new Set(["constructor", "dup"]);

type CallResult = {
  args: unknown[];
  path: string[];
};

export class IterateContext extends RpcTarget {
  readonly #props: unknown;

  constructor(props: unknown = {}) {
    super();
    this.#props = props;

    // POC only: return a Proxy from an RpcTarget constructor to test whether a
    // server-owned RpcTarget can expose unknown method/property paths without
    // predeclaring them on the class prototype.
    //
    // Effect:
    //   target.slack.chat.postMessage({ text: "hi" })
    // resolves unknown members through this get trap until the final call
    // reaches createCallablePathProxy(...), which records:
    //   { path: ["slack", "chat", "postMessage"], args: [...] }
    //
    // The Proxy preserves real RpcTarget members first, avoids `then` so the
    // object is not accidentally treated as a Promise, and skips RPC-reserved
    // names. This file exists because Workers RPC and Cap'n Web client stubs
    // are already Proxy-backed, but wrapping the server-side RpcTarget itself
    // has historically had runtime caveats.
    //
    // References:
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Cap'n Web README: https://github.com/cloudflare/capnweb
    // - Server-side Proxy/RpcTarget limitation thread:
    //   https://github.com/cloudflare/workerd/issues/3184
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop !== "string" || prop === "then") {
          return Reflect.get(target, prop, receiver);
        }
        if (rpcReservedNames.has(prop)) return Reflect.get(target, prop, receiver);

        const existing = Reflect.get(target, prop, receiver);
        if (existing !== undefined) {
          return typeof existing === "function" ? existing.bind(receiver) : existing;
        }

        return createCallablePathProxy([prop], () => this.#props);
      },
    });
  }

  async describe() {
    return { props: this.#props };
  }
}

class CapnWebIterateContext extends CapnWebRpcTarget {
  constructor() {
    super();
    // POC only: same server-side catchall experiment as IterateContext above,
    // but using capnweb's RpcTarget implementation directly. This lets us test
    // whether Cap'n Web over WebSocket observes the same behavior as native
    // Workers RPC when the exported target is itself Proxy-wrapped.
    //
    // Effect:
    //   capnwebCtx.some.deep.method(arg)
    // records path ["some", "deep", "method"] and args [arg], while real
    // class members still win. `then` is excluded so Cap'n Web promise handling
    // does not confuse this catchall object with a thenable.
    //
    // References:
    // - Cap'n Web README: https://github.com/cloudflare/capnweb
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Server-side Proxy/RpcTarget limitation thread:
    //   https://github.com/cloudflare/workerd/issues/3184
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop === "then") {
          return Reflect.get(target, prop, receiver);
        }
        if (rpcReservedNames.has(prop)) return Reflect.get(target, prop, receiver);

        const existing = Reflect.get(target, prop, receiver);
        if (existing !== undefined) {
          return typeof existing === "function" ? existing.bind(receiver) : existing;
        }

        return createCapnWebCallablePathProxy([prop]);
      },
    });
  }
}

export class IterateContextEntrypoint extends WorkerEntrypoint<Env, { props?: unknown }> {
  get context() {
    const workerCtx = Reflect.get(this, "ctx", this) as { props?: unknown };
    return new IterateContext(workerCtx.props ?? {});
  }

  getContext() {
    const workerCtx = Reflect.get(this, "ctx", this) as { props?: unknown };
    return new IterateContext(workerCtx.props ?? {});
  }

  constructor(ctx: never, env: never) {
    super(ctx, env);

    // POC only: return a Proxy from a WorkerEntrypoint constructor to test the
    // "ctx as context capability" idea. WorkerEntrypoint already has an
    // instance `ctx` field for the execution context, so the trap replaces only
    // reads of `entrypoint.ctx` with getContext(). All other members fall
    // through to the real WorkerEntrypoint.
    //
    // This is intentionally *not* the production model because overloading
    // WorkerEntrypoint.ctx is confusing. The production code uses
    // env.ITERATE.context instead.
    //
    // References:
    // - Dynamic Workers API: https://developers.cloudflare.com/dynamic-workers/api-reference/
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Server-side Proxy/RpcTarget limitation thread:
    //   https://github.com/cloudflare/workerd/issues/3184
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "ctx") {
          return target.getContext();
        }
        if (typeof prop !== "string" || prop === "then") {
          return Reflect.get(target, prop, receiver);
        }
        if (rpcReservedNames.has(prop)) return Reflect.get(target, prop, receiver);
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}

function createCallablePathProxy(path: string[], getProps: () => unknown) {
  const callable = async (...args: unknown[]): Promise<CallResult> => ({
    args,
    path,
  });

  // POC only: callable path recorder used by the Worker RPC experiment above.
  // Every unknown property appends one path segment; invoking the function
  // returns the recorded path and args. getPrototypeOf reports RpcTarget's
  // prototype to probe whether Workers RPC treats this callable proxy as a
  // target-shaped value when it crosses an RPC boundary.
  //
  // Effect:
  //   proxy.a.b(1)
  // returns:
  //   { path: ["a", "b"], args: [1] }
  //
  // References:
  // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
  // - Server-side Proxy/RpcTarget limitation thread:
  //   https://github.com/cloudflare/workerd/issues/3184
  return new Proxy(callable, {
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop === "then") {
        return Reflect.get(target, prop, receiver);
      }
      if (rpcReservedNames.has(prop)) return Reflect.get(target, prop, receiver);
      return createCallablePathProxy([...path, prop], getProps);
    },
  });
}

function createCapnWebCallablePathProxy(path: string[]) {
  const callable = async (...args: unknown[]): Promise<CallResult> => ({
    args,
    path,
  });

  // POC only: Cap'n Web version of the callable path recorder above. It reports
  // capnweb's RpcTarget prototype through getPrototypeOf so the experiment can
  // compare native Workers RPC and Cap'n Web behavior for Proxy-backed
  // callable targets.
  //
  // Effect:
  //   proxy.slack.chat.postMessage(payload)
  // returns:
  //   { path: ["slack", "chat", "postMessage"], args: [payload] }
  //
  // References:
  // - Cap'n Web README: https://github.com/cloudflare/capnweb
  // - Server-side Proxy/RpcTarget limitation thread:
  //   https://github.com/cloudflare/workerd/issues/3184
  return new Proxy(callable, {
    getPrototypeOf() {
      return CapnWebRpcTarget.prototype;
    },
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop === "then") {
        return Reflect.get(target, prop, receiver);
      }
      if (rpcReservedNames.has(prop)) return Reflect.get(target, prop, receiver);
      return createCapnWebCallablePathProxy([...path, prop]);
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { exports: Exports }) {
    const url = new URL(request.url);

    if (url.pathname === "/capnweb") {
      return newWorkersRpcResponse(request, new CapnWebIterateContext());
    }

    if (url.pathname === "/dynamic") {
      return Response.json(await runDynamicWorkerProbe(env, ctx));
    }

    return new Response("not found", { status: 404 });
  },
};

async function runDynamicWorkerProbe(env: Env, ctx: ExecutionContext & { exports: Exports }) {
  const entrypoint = env.LOADER.load({
    compatibilityDate: "2026-04-27",
    mainModule: "worker.js",
    modules: {
      "worker.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";

        export default class extends WorkerEntrypoint {
          async run() {
              return await this.env.ITERATE.context.slack.chat.postMessage({
              marker: "dynamic",
              text: "hi",
            });
          }
        }
      `,
    },
    env: {
      ITERATE: ctx.exports.IterateContextEntrypoint({
        props: { source: "dynamic" },
      }),
    },
  }).getEntrypoint() as { run(): Promise<CallResult> } & Partial<Disposable>;

  try {
    return await entrypoint.run();
  } finally {
    entrypoint[Symbol.dispose]?.();
  }
}

export type IterateContextApi = {
  describe(): Promise<{ props: unknown }>;
  slack: {
    chat: {
      postMessage(input: unknown): Promise<CallResult>;
    };
  };
};

type Exports = {
  IterateContextEntrypoint(options: { props: unknown }): {
    context: IterateContextApi;
    getContext(): IterateContextApi;
  };
};

type Env = {
  LOADER: WorkerLoader;
};
