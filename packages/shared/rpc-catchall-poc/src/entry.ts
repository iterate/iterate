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

    // This is the trick under test: the RpcTarget instance itself becomes a
    // catchall object, but still reports an RpcTarget prototype to RPC.
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

    // The proxy path tests the "get ctx" idea. The prototype method above is
    // what Workers RPC actually sees, because WorkerEntrypoint owns an instance
    // `ctx` execution-context field.
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
