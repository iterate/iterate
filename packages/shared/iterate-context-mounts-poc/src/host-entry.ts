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
      };
    },
  ) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("iterate-context-mounts-poc", { status: 404 });
    }

    const body = (await request.json()) as {
      props: IterateContextProps;
      action: "callMounted" | "getMounted" | "localProxy" | "prototypeMethod";
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
          const fn = (iterateCtx as Record<string, unknown>)[method];
          if (typeof fn !== "function") {
            return Response.json({ error: `method not found: ${method}` }, { status: 400 });
          }
          return Response.json({
            value: await fn.apply(iterateCtx, body.methodArgs ?? []),
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
