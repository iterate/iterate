import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createLocalCtxProxy } from "./local-proxy.ts";
import { runLocalProxyScenario } from "./local-proxy-scenarios.ts";
import { createIterateContext } from "./iterate-context.ts";
import {
  IterateContextService,
  registerIterateContext,
  unregisterIterateContext,
} from "./iterate-context-service.ts";
import type { IterateContextProps } from "./types.ts";

export { IterateContextService };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext & {
      exports: {
        IterateContextService(options: { props: { contextId: string } }): {
          getIterateContext(): unknown;
        } & Partial<Disposable>;
        RemoteProbe(options: { props?: Record<string, never> }): {
          call(input: {
            args: unknown[];
            method: string;
            target: Record<string, unknown>;
          }): Promise<unknown>;
          callSlackStyle(input: {
            args: unknown[];
            target: Record<string, unknown>;
          }): Promise<unknown>;
        } & Partial<Disposable>;
        ConstructorProxyEntrypoint(options: {
          props?: Record<string, never>;
        }): Record<string, unknown> & Partial<Disposable>;
      };
    },
  ) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("iterate-context-mounts-poc", { status: 404 });
    }

    const body = (await request.json()) as {
      props: IterateContextProps;
      action: "callMounted" | "getMounted" | "localProxy" | "prototypeMethod" | "catchallProbe";
      path?: string[];
      args?: unknown[];
      scenario?: string;
      method?: string;
      methodArgs?: unknown[];
    };

    let iterateCtx!: ReturnType<typeof createIterateContext>;
    let contextId!: string;
    iterateCtx = createIterateContext({
      loader: env.LOADER,
      props: body.props,
      getIterateStub: () => ctx.exports.IterateContextService({ props: { contextId } }),
    });
    contextId = registerIterateContext(iterateCtx);

    try {
      switch (body.action) {
        case "callMounted":
          return Response.json({
            value: await iterateCtx.callMounted(body.path ?? [], body.args ?? []),
          });
        case "getMounted":
          return Response.json({
            value: await iterateCtx.getMounted(body.path ?? []),
          });
        case "prototypeMethod": {
          const method = body.method;
          if (!method) return Response.json({ error: "method required" }, { status: 400 });
          return Response.json({
            value: await ctx.exports.RemoteProbe({ props: {} }).call({
              args: body.methodArgs ?? [],
              method,
              target: iterateCtx as unknown as Record<string, unknown>,
            }),
          });
        }
        case "catchallProbe": {
          const probe = ctx.exports.RemoteProbe({ props: {} });
          const args = body.methodArgs ?? [{ channel: "C123", text: "hi" }];
          return Response.json({
            value: {
              rpcTargetConstructorProxy: await captureError(() =>
                probe.callSlackStyle({
                  args,
                  target: new ConstructorProxyRpcTarget() as unknown as Record<string, unknown>,
                }),
              ),
              rpcTargetGetterReturnsProxy: await captureError(() =>
                probe.callSlackStyle({
                  args,
                  target: new GetterProxyRpcTarget() as unknown as Record<string, unknown>,
                }),
              ),
              workerEntrypointConstructorProxyDirect: await captureError(() =>
                callSlackStyle({
                  args,
                  target: ctx.exports.ConstructorProxyEntrypoint({
                    props: {},
                  }) as unknown as Record<string, unknown>,
                }),
              ),
              workerEntrypointConstructorProxy: await captureError(() =>
                probe.callSlackStyle({
                  args,
                  target: ctx.exports.ConstructorProxyEntrypoint({
                    props: {},
                  }) as unknown as Record<string, unknown>,
                }),
              ),
            },
          });
        }
        case "localProxy": {
          const proxy = createLocalCtxProxy(iterateCtx, body.props.mounts);
          return Response.json({
            value: await runLocalProxyScenario(body.scenario ?? "", proxy),
          });
        }
        default:
          return Response.json({ error: "unknown action" }, { status: 400 });
      }
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        { status: 500 },
      );
    } finally {
      unregisterIterateContext(contextId);
      iterateCtx[Symbol.dispose]?.();
    }
  },
};

export interface Env {
  LOADER: WorkerLoader;
}

export class RemoteProbe extends WorkerEntrypoint {
  async call(input: { args: unknown[]; method: string; target: Record<string, unknown> }) {
    const fn = input.target[input.method];
    if (typeof fn !== "function") {
      throw new Error(`method not found over RPC: ${input.method}`);
    }
    return await fn(...input.args);
  }

  async callSlackStyle(input: { args: unknown[]; target: Record<string, unknown> }) {
    const slack = input.target.slack as {
      chat?: {
        postMessage?: (...args: unknown[]) => unknown;
      };
    };
    const postMessage = slack.chat?.postMessage;
    if (typeof postMessage !== "function") {
      throw new Error(`slack.chat.postMessage not callable; got ${typeof postMessage}`);
    }
    return await postMessage(...input.args);
  }
}

async function callSlackStyle(input: { args: unknown[]; target: Record<string, unknown> }) {
  const slack = input.target.slack as {
    chat?: {
      postMessage?: (...args: unknown[]) => unknown;
    };
  };
  const postMessage = slack.chat?.postMessage;
  if (typeof postMessage !== "function") {
    throw new Error(`slack.chat.postMessage not callable; got ${typeof postMessage}`);
  }
  return await postMessage(...input.args);
}

export class ConstructorProxyEntrypoint extends WorkerEntrypoint {
  constructor(ctx: never, env: never) {
    super(ctx, env);
    // POC only: this returns a Proxy from a WorkerEntrypoint constructor to
    // discover whether a dynamic/remote WorkerEntrypoint can act as a catchall
    // RPC target without predeclared prototype methods.
    //
    // Effect:
    //   entrypoint.slack.chat.postMessage({ text: "hi" })
    // records path ["slack", "chat", "postMessage"] and the final call args
    // via createCallablePathProxy(...).
    //
    // This is intentionally not the production design. Production dynamic
    // mounts keep the dynamic worker owned by the parent with the loader
    // binding and forward calls through explicit RpcTarget methods, because
    // server-side Proxy-wrapped RpcTarget/WorkerEntrypoint behavior has had
    // runtime-specific edge cases.
    //
    // References:
    // - Dynamic Workers API: https://developers.cloudflare.com/dynamic-workers/api-reference/
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Server-side Proxy/RpcTarget limitation thread:
    //   https://github.com/cloudflare/workerd/issues/3184
    return createCatchallProxy([], this) as ConstructorProxyEntrypoint;
  }
}

class ConstructorProxyRpcTarget extends RpcTarget {
  constructor() {
    super();
    // POC only: same catchall experiment as ConstructorProxyEntrypoint, but for
    // a plain RpcTarget. The returned Proxy lets the test compare whether
    // native RpcTarget and WorkerEntrypoint behave the same when the actual
    // exported object is Proxy-wrapped.
    //
    // References:
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Server-side Proxy/RpcTarget limitation thread:
    //   https://github.com/cloudflare/workerd/issues/3184
    return createCatchallProxy([], this) as ConstructorProxyRpcTarget;
  }
}

class GetterProxyRpcTarget extends RpcTarget {
  get slack() {
    return createCallablePathProxy(["slack"]);
  }
}

function createCatchallProxy(path: string[], target: object): object {
  // POC only: catchall object wrapper. Real members of the target win, unknown
  // properties become a callable recorded path.
  //
  // Effect:
  //   proxy.some.path.method(1, 2)
  // returns:
  //   { path: ["some", "path", "method"], args: [1, 2] }
  //
  // References:
  // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
  // - Cap'n Web README: https://github.com/cloudflare/capnweb
  // - Server-side Proxy/RpcTarget limitation thread:
  //   https://github.com/cloudflare/workerd/issues/3184
  return new Proxy(target, {
    get(innerTarget, prop, receiver) {
      if (typeof prop === "symbol" || prop in innerTarget) {
        return Reflect.get(innerTarget, prop, receiver);
      }
      return createCallablePathProxy([...path, prop]);
    },
  });
}

function createCallablePathProxy(path: string[]): (...args: unknown[]) => unknown {
  const fn = () => undefined;
  // POC only: infinite local SDK path. Each property read extends `path`; the
  // final function call returns the recorded path and args. `then` is
  // deliberately undefined so await/promise assimilation does not accidentally
  // treat the path recorder as a Promise.
  //
  // This is the minimal experiment behind the production Slack-style requirement:
  //   ctx.slack.chat.postMessage(...)
  // where the Slack hierarchy is not known ahead of time.
  //
  // References:
  // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
  // - Cap'n Web README: https://github.com/cloudflare/capnweb
  return new Proxy(fn, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined;
      return createCallablePathProxy([...path, prop]);
    },
    apply(_target, _thisArg, args) {
      return {
        path,
        args,
      };
    },
  });
}

async function captureError(fn: () => Promise<unknown>) {
  try {
    return {
      ok: true,
      value: await fn(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    };
  }
}
