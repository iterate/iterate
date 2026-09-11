import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget as CapnRpcTarget } from "capnweb";

type Env = {
  LOADER: WorkerLoader;
  OUTBOUND: Fetcher;
  PROBE: DurableObjectNamespace<ProbeContext>;
  VERSION: { id: string };
};
type TerminalMode = "local" | "outbound" | "accepted" | "conflict" | "external" | "slow" | "gzip";
type LoopbackProps = { static?: boolean };
type WorkerTarget = { kind: "worker"; source: { modules: Record<string, string> } };
type Target = WorkerTarget | { kind: "terminal"; mode: TerminalMode };
type DestinationProps = {
  anonymous?: boolean;
  cached?: boolean;
  hold?: boolean;
  reentry?: boolean;
  appHost?: boolean;
  policyHost?: boolean;
  pipe?: boolean;
  slow?: boolean;
  gzip?: boolean;
  target: Target;
};
type FetchNextProps = {
  anonymous?: boolean;
  cached?: boolean;
  hold?: boolean;
  reentry?: boolean;
  appHost?: boolean;
  policyHost?: boolean;
  pipe?: boolean;
  slow?: boolean;
  gzip?: boolean;
};
type ReentryHostProps = { policyHost?: boolean; slow?: boolean; gzip?: boolean };
type ProbeExports = {
  BuildService(options: { props: Record<string, never> }): Fetcher;
  BuildHost(options: { props: { service?: boolean } }): Fetcher;
  CapabilityHost(options: { props: Record<string, never> }): Fetcher;
  FetcherHost(options: { props: Record<string, never> }): Fetcher;
  ReentryHost(options: { props: ReentryHostProps }): Fetcher;
  StaticTarget(options: { props: Record<string, never> }): Fetcher;
  Outbound(options: { props: Record<string, never> }): Fetcher;
  Loopback(options: { props: LoopbackProps }): Fetcher;
  FetchNext(options: { props: FetchNextProps }): Fetcher;
  Destination(options: { props: DestinationProps }): Fetcher;
};
type LoaderPolicy = { source: string };

const childSource = `export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/http")) {
      if (new URL(request.url).pathname.includes("itx")) {
        const scope = await env.ITX.get();
        const value = await scope.ping();
        if (new URL(request.url).pathname.includes("dispose")) scope[Symbol.dispose]();
        return new Response(value);
      }
      if (new URL(request.url).pathname.includes("outbound")) return fetch("https://outbound.invalid/");
      return new Response("child-http");
    }
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", event => pair[1].send("child:" + event.data));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}`;
const fetcherChildSource = `export default {
  async fetch(request, env) {
    const target = env.TARGET || await env.ITX.get();
    const response = await target.fetch(request);
    if (new URL(request.url).pathname.includes("dispose")) target[Symbol.dispose]();
    return response;
  }
}`;
const child: WorkerLoaderWorkerCode = {
  compatibilityDate: "2026-09-01",
  mainModule: "echo.js",
  modules: {
    "echo.js": childSource,
  },
};
const policySource = `export default {
  async fetch(request, env) {
    const headers = new Headers(request.headers);
    headers.set("x-probe-policy", "next");
    return (await env.NEXT.to({ kind: "worker", source: { modules: { "echo.js": ${JSON.stringify(childSource)} } } })).fetch(new Request(request, { headers }));
  }
}`;
const boundPolicySource = `export default {
  fetch(request, env) {
    const headers = new Headers(request.headers);
    headers.set("x-probe-policy", "bound");
    return env.DESTINATION.fetch(new Request(request, { headers }));
  }
}`;
const terminalPolicySource = (mode: TerminalMode) => `export default {
  async fetch(request, env) {
    return (await env.NEXT.to({ kind: "terminal", mode: ${JSON.stringify(mode)} })).fetch(request);
  }
}`;
const reentrantAppSource = `export default {
  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair(); pair[1].accept();
      pair[1].addEventListener('message', event => pair[1].send('reentrant:' + event.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const response = await fetch(request);
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
}`;
const reentrantPolicySource = `export default {
  async fetch(request, env) {
    return (await env.NEXT.to({ kind: "worker", source: { modules: { "echo.js": ${JSON.stringify(reentrantAppSource)} } } })).fetch(request);
  }
}`;
const buildChildSource = `export default {
  async fetch(request, env) {
    const scope = await env.ITX.get();
    const value = await scope[new URL(request.url).pathname.split('-').at(-1)]();
    return Response.json(value);
  }
}`;

function echo(prefix: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].addEventListener("message", (event) => pair[1].send(`${prefix}:${event.data}`));
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function loaded(env: Env): Fetcher {
  return env.LOADER.load(child).getEntrypoint();
}

function targetCode(target: WorkerTarget): WorkerLoaderWorkerCode {
  return { ...child, modules: target.source.modules };
}

function targetWorker(
  env: Env,
  target: WorkerTarget,
  cached: boolean,
  anonymous = false,
  globalOutbound?: Fetcher,
  cacheName = globalOutbound ? "outbound-v1" : "echo-v1",
  injectItx = false,
): WorkerStub {
  const code = targetCode(target);
  if (globalOutbound) {
    code.globalOutbound = globalOutbound;
    if (injectItx) code.env = { ...code.env, ITX: globalOutbound };
  }
  return cached
    ? env.LOADER.get(
        anonymous ? null : JSON.stringify([env.VERSION.id, "comparison:itx", cacheName]),
        () => code,
      )
    : env.LOADER.load(code);
}

function itxWorker(env: Env, ctx: ExecutionContext, cached: boolean): WorkerStub {
  const code = targetCode({ kind: "worker", source: { modules: { "echo.js": childSource } } });
  code.env = { ITX: (ctx.exports as unknown as ProbeExports).CapabilityHost({ props: {} }) };
  return cached
    ? env.LOADER.get(JSON.stringify([env.VERSION.id, "comparison:itx", "itx-v1"]), () => code)
    : env.LOADER.load(code);
}

function fetcherWorker(env: Env, ctx: ExecutionContext, returned: boolean): WorkerStub {
  const exports = ctx.exports as unknown as ProbeExports;
  return env.LOADER.load({
    compatibilityDate: "2026-09-01",
    mainModule: "fetcher.js",
    modules: { "fetcher.js": fetcherChildSource },
    env: returned
      ? { ITX: exports.FetcherHost({ props: {} }) }
      : { TARGET: exports.StaticTarget({ props: {} }) },
  });
}

/** Native RPC promise with the optional disposal hook exposed by workerd at runtime. */
type DisposablePromise<T> = PromiseLike<T> & Partial<Disposable>;

/**
 * Plain-data-only equivalent of project-core's Scope.build facade. The three methods differ
 * solely in whether the Context native RPC thenable is forwarded, awaited, or disposed after
 * settlement. It is diagnostic-only: `BuildValue` cannot contain a capability or stream.
 */
class BuildScope extends RpcTarget {
  constructor(private readonly call: () => Promise<BuildValue>) {
    super();
  }
  direct() {
    return this.call();
  }
  async awaited() {
    return await this.call();
  }
  async disposed() {
    const pending: DisposablePromise<BuildValue> = this.call();
    try {
      return await pending;
    } finally {
      pending[Symbol.dispose]?.();
    }
  }
}

type BuildArm = "direct" | "awaited" | "disposed";

/** The `Scope.build` leaf exposed to the Cap'n Web client. */
class CapnBuilder extends CapnRpcTarget {
  constructor(
    private readonly call: () => Promise<BuildValue>,
    private readonly arm: BuildArm,
  ) {
    super();
  }
  build() {
    if (this.arm === "direct") return this.call();
    if (this.arm === "awaited") return this.awaited();
    return this.disposed();
  }
  private async awaited() {
    return await this.call();
  }
  private async disposed() {
    const pending: DisposablePromise<BuildValue> = this.call();
    try {
      return await pending;
    } finally {
      pending[Symbol.dispose]?.();
    }
  }
}

/** The same `Scope.build.build()` facade shape across a Cap'n Web WebSocket boundary. */
class CapnBuildScope extends CapnRpcTarget {
  constructor(
    private readonly call: () => Promise<BuildValue>,
    private readonly arm: BuildArm,
  ) {
    super();
  }
  get build() {
    return new CapnBuilder(this.call, this.arm);
  }
}

type BuildValue = { marker: "plain-build-data"; value: number };

/** Returns the per-call Builder-shaped native RPC target to a loaded child. */
export class BuildHost extends WorkerEntrypoint<Env, { service?: boolean }> {
  get() {
    const context = this.env.PROBE.getByName("comparison");
    return new BuildScope(() =>
      this.ctx.props.service ? context.buildService() : context.build(),
    );
  }
}

function buildWorker(env: Env, ctx: ExecutionContext, service = false): WorkerStub {
  return env.LOADER.load({
    compatibilityDate: "2026-09-01",
    mainModule: "build.js",
    modules: { "build.js": buildChildSource },
    env: { ITX: (ctx.exports as unknown as ProbeExports).BuildHost({ props: { service } }) },
  });
}

function clean(request: Request) {
  return new Request(request, { headers: new Headers(request.headers), redirect: "manual" });
}

function terminal(env: Env, mode: TerminalMode) {
  return env.PROBE.getByName("comparison").fetch(`https://terminal.invalid/${mode}`);
}

function policy(
  env: Env,
  source: string,
  bindings: Record<string, unknown>,
  host?: Fetcher,
): Fetcher {
  return env.LOADER.load({
    compatibilityDate: "2026-09-01",
    mainModule: "policy.js",
    modules: { "policy.js": source },
    env: { ...bindings, ...(host && { ITX: host }) },
    ...(host && { globalOutbound: host }),
  }).getEntrypoint();
}

/** Static native Fetcher hop before the same dynamic child. */
export class Loopback extends WorkerEntrypoint<Env, LoopbackProps> {
  override fetch(request: Request): Promise<Response> {
    if (this.ctx.props.static) return Promise.resolve(echo("loopback-static"));
    return loaded(this.env).fetch(request);
  }
}

/** A finite terminal response, used only to test a loaded child's outbound capability lifetime. */
export class Outbound extends WorkerEntrypoint<Env> {
  override fetch(): Response {
    return new Response("outbound-http");
  }
}

class ProbeScope extends RpcTarget {
  ping(): string {
    return "itx-http";
  }
}

/** Mirrors Host.get(): a static entrypoint returns a native RPC target to loaded code. */
export class CapabilityHost extends WorkerEntrypoint<Env> {
  get(): ProbeScope {
    return new ProbeScope();
  }
}

/** A static Fetcher returned across RPC, matching NEXT.to()'s public transport shape. */
export class FetcherHost extends WorkerEntrypoint<Env> {
  get(): Fetcher {
    return (this.ctx.exports as unknown as ProbeExports).StaticTarget({ props: {} });
  }
}

/** Mirrors globalOutbound: re-enter a second fresh policy, then select the terminal. */
export class ReentryHost extends WorkerEntrypoint<Env, ReentryHostProps> {
  override fetch(request: Request): Promise<Response> {
    const exports = this.ctx.exports as unknown as ProbeExports;
    const host = this.ctx.props.policyHost
      ? exports.ReentryHost({ props: { policyHost: true } })
      : undefined;
    return policy(
      this.env,
      terminalPolicySource(
        this.ctx.props.gzip ? "gzip" : this.ctx.props.slow ? "slow" : "accepted",
      ),
      {
        NEXT: exports.FetchNext({ props: {} }),
      },
      host,
    ).fetch(clean(request));
  }
}

/** Finite body only: no DO, loader, outbound, socket, or persistent effect. */
export class StaticTarget extends WorkerEntrypoint<Env> {
  override fetch(): Response {
    return new Response("fetcher-http");
  }
}

/** The static destination is the same loaded-child hop used by project-core's policy. */
export class Destination extends WorkerEntrypoint<Env, DestinationProps> {
  override async fetch(request: Request) {
    await this.env.PROBE.getByName("comparison").fetchPolicyOffset();
    if (this.ctx.props.target.kind === "terminal")
      return terminal(this.env, this.ctx.props.target.mode);
    const worker = targetWorker(
      this.env,
      this.ctx.props.target,
      this.ctx.props.cached ?? false,
      this.ctx.props.anonymous,
      this.ctx.props.reentry
        ? (this.ctx.exports as unknown as ProbeExports).ReentryHost({
            props: {
              ...(this.ctx.props.policyHost && { policyHost: true }),
              ...(this.ctx.props.slow && { slow: true }),
              ...(this.ctx.props.gzip && { gzip: true }),
            },
          })
        : (this.ctx.exports as unknown as ProbeExports).Outbound({ props: {} }),
      undefined,
      this.ctx.props.appHost,
    );
    const response = worker.getEntrypoint().fetch(clean(request));
    if (!this.ctx.props.pipe) return this.ctx.props.hold ? await response : response;
    const received = await response;
    return received.body
      ? new Response(received.body.pipeThrough(new TransformStream()), received)
      : received;
  }
}

/** The policy receives this as a native RPC capability, then receives a static Fetcher back. */
export class FetchNext extends WorkerEntrypoint<Env, FetchNextProps> {
  to(target: Target) {
    // workers-types cannot represent this module's named static export table.
    return (this.ctx.exports as unknown as ProbeExports).Destination({
      props: { ...this.ctx.props, target },
    });
  }
}

/** Adds only the actor boundary present in project-core's failing route. */
export class ProbeContext extends DurableObject<Env> {
  /** Return only cloneable data so explicit disposal, if tested, cannot dispose a capability. */
  build(): BuildValue {
    return { marker: "plain-build-data", value: 1 };
  }
  /** Same plain value but through a second native static Worker RPC, like Context -> BUNDLER. */
  buildService(): Promise<BuildValue> {
    const service = (
      this.ctx.exports as unknown as {
        BuildService(options: { props: Record<string, never> }): { build(): Promise<BuildValue> };
      }
    ).BuildService({ props: {} });
    return service.build();
  }

  /** Mirrors the policy-offset freshness RPC before a destination loads its child. */
  fetchPolicyOffset(): number {
    return 1;
  }

  /** Returns inert source over Workers RPC; it never returns a Fetcher or WebSocket. */
  loaderPolicy(): LoaderPolicy {
    return { source: childSource };
  }

  override fetch(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/local":
        return Promise.resolve(new Response("terminal-local"));
      case "/accepted":
        return Promise.resolve(new Response("terminal-accepted", { status: 202 }));
      case "/slow":
        return Promise.resolve(
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("terminal-"));
                await new Promise((resolve) => setTimeout(resolve, 500));
                controller.enqueue(new TextEncoder().encode("accepted"));
                controller.close();
              },
            }),
            { status: 202 },
          ),
        );
      case "/gzip":
        return Promise.resolve(
          new Response(
            Uint8Array.from(atob("H4sIAAAAAAAAEytJLcrNzEvM0U1MTk4tKElNAQCqUrN6EQAAAA=="), (byte) =>
              byte.charCodeAt(0),
            ),
            {
              encodeBody: "manual",
              status: 202,
              headers: {
                "content-encoding": "gzip",
                "content-length": "37",
                "content-type": "text/plain",
              },
            },
          ),
        );
      case "/conflict":
        return Promise.resolve(new Response("terminal-conflict", { status: 409 }));
      case "/external":
        return fetch("https://example.com/");
      case "/outbound":
        return (this.ctx.exports as unknown as ProbeExports).Outbound({ props: {} }).fetch(request);
      case "/do-static":
        return Promise.resolve(echo("do-static"));
      case "/do-loader":
        return loaded(this.env).fetch(request);
      case "/do-loopback-static":
        return (this.ctx.exports as unknown as ProbeExports)
          .Loopback({ props: { static: true } })
          .fetch(request);
    }
    // workers-types exposes `Exports` without this module's named static entrypoint.
    return (this.ctx.exports as unknown as ProbeExports).Loopback({ props: {} }).fetch(request);
  }
}

/** Static service equivalent used only by the nested native-RPC build diagnostic. */
export class BuildService extends WorkerEntrypoint<Env> {
  build(): BuildValue {
    return { marker: "plain-build-data", value: 1 };
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/static":
        return Promise.resolve(echo("static"));
      case "/loader":
        return loaded(env).fetch(request);
      case "/cached-loader": {
        const worker = targetWorker(
          env,
          { kind: "worker", source: { modules: { "echo.js": childSource } } },
          true,
        );
        return worker.getEntrypoint().fetch(request);
      }
      case "/http-static":
        return Promise.resolve(new Response("static-http"));
      case "/http-loader":
        return loaded(env).fetch(request);
      case "/http-cached-loader":
        return targetWorker(
          env,
          { kind: "worker", source: { modules: { "echo.js": childSource } } },
          true,
        )
          .getEntrypoint()
          .fetch(request);
      case "/http-outbound-loader":
      case "/http-outbound-cached":
        return targetWorker(
          env,
          { kind: "worker", source: { modules: { "echo.js": childSource } } },
          new URL(request.url).pathname.includes("cached"),
          false,
          (ctx.exports as unknown as ProbeExports).Outbound({ props: {} }),
        )
          .getEntrypoint()
          .fetch(request);
      case "/http-outbound-cached-held":
        return (async () => {
          const worker = targetWorker(
            env,
            { kind: "worker", source: { modules: { "echo.js": childSource } } },
            true,
            false,
            (ctx.exports as unknown as ProbeExports).Outbound({ props: {} }),
          );
          const response = await worker.getEntrypoint().fetch(request);
          return new Response(await response.text());
        })();
      case "/http-outbound-cached-copy":
        return (async () => {
          const worker = targetWorker(
            env,
            { kind: "worker", source: { modules: { "echo.js": childSource } } },
            true,
            false,
            (ctx.exports as unknown as ProbeExports).Outbound({ props: {} }),
          );
          const response = await worker.getEntrypoint().fetch(request);
          return new Response(response.body, response);
        })();
      case "/http-outbound-anonymous":
        return targetWorker(
          env,
          { kind: "worker", source: { modules: { "echo.js": childSource } } },
          true,
          true,
          (ctx.exports as unknown as ProbeExports).Outbound({ props: {} }),
        )
          .getEntrypoint()
          .fetch(request);
      case "/http-outbound-service-cached":
        return targetWorker(
          env,
          { kind: "worker", source: { modules: { "echo.js": childSource } } },
          true,
          false,
          env.OUTBOUND,
          "service-outbound-v1",
        )
          .getEntrypoint()
          .fetch(request);
      case "/http-itx-loader":
      case "/http-itx-cached":
      case "/http-itx-dispose":
      case "/http-itx-cached-dispose":
        return itxWorker(env, ctx, new URL(request.url).pathname.includes("cached"))
          .getEntrypoint()
          .fetch(request);
      case "/http-fetcher-direct":
        return fetcherWorker(env, ctx, false).getEntrypoint().fetch(request);
      case "/http-fetcher-return":
      case "/http-fetcher-return-dispose":
        return fetcherWorker(env, ctx, true).getEntrypoint().fetch(request);
      case "/http-build-direct":
      case "/http-build-awaited":
      case "/http-build-disposed":
        return buildWorker(env, ctx).getEntrypoint().fetch(request);
      case "/http-build-service-direct":
      case "/http-build-service-awaited":
      case "/http-build-service-disposed":
        return buildWorker(env, ctx, true).getEntrypoint().fetch(request);
      case "/capn-build": {
        const arm = new URL(request.url).searchParams.get("arm");
        if (arm !== "direct" && arm !== "awaited" && arm !== "disposed")
          return Promise.resolve(new Response("unknown build arm", { status: 400 }));
        const context = env.PROBE.getByName("comparison");
        const call =
          new URL(request.url).searchParams.get("source") === "service"
            ? () => context.buildService()
            : () => context.build();
        return newWorkersRpcResponse(request, new CapnBuildScope(call, arm));
      }
      case "/http-policy":
      case "/http-policy-cached":
        return policy(env, policySource, {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({
            props: { cached: new URL(request.url).pathname.endsWith("cached") },
          }),
        }).fetch(clean(request));
      case "/loopback-loader":
        // workers-types exposes `Exports` without this module's named static entrypoint.
        return (ctx.exports as unknown as ProbeExports).Loopback({ props: {} }).fetch(request);
      case "/do-loopback-loader":
      case "/do-static":
      case "/do-loader":
      case "/do-loopback-static":
        return env.PROBE.getByName("comparison").fetch(request);
      case "/rpc-policy-loader":
        return env.PROBE.getByName("comparison")
          .loaderPolicy()
          .then((policy) =>
            env.LOADER.load({ ...child, modules: { "echo.js": policy.source } })
              .getEntrypoint()
              .fetch(request),
          );
      case "/core-chain-next":
      case "/http-core-chain-next":
        // Dynamic policy -> native RPC `NEXT.to()` -> static destination -> dynamic child.
        return policy(env, policySource, {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({ props: {} }),
        }).fetch(clean(request));
      case "/core-chain-cached-next":
        return policy(env, policySource, {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({ props: { cached: true } }),
        }).fetch(clean(request));
      case "/core-chain-cached-held-next":
        return policy(env, policySource, {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({
            props: { cached: true, hold: true },
          }),
        }).fetch(clean(request));
      case "/core-chain-anonymous-next":
        return policy(env, policySource, {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({
            props: { cached: true, anonymous: true },
          }),
        }).fetch(clean(request));
      case "/core-chain-destination":
      case "/http-core-chain-destination":
        // Same policy child and destination, but the Fetcher is injected directly.
        return policy(env, boundPolicySource, {
          DESTINATION: (ctx.exports as unknown as ProbeExports).Destination({
            props: { target: { kind: "worker", source: { modules: { "echo.js": childSource } } } },
          }),
        }).fetch(clean(request));
      case "/http-terminal-local-direct":
        return terminal(env, "local");
      case "/http-terminal-outbound-direct":
        return terminal(env, "outbound");
      case "/http-terminal-local-policy":
      case "/http-terminal-outbound-policy": {
        const mode = new URL(request.url).pathname.includes("outbound") ? "outbound" : "local";
        return policy(env, terminalPolicySource(mode), {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({ props: {} }),
        }).fetch(clean(request));
      }
      case "/http-terminal-accepted-direct":
        return terminal(env, "accepted");
      case "/http-terminal-conflict-direct":
        return terminal(env, "conflict");
      case "/http-terminal-external-direct":
        return terminal(env, "external");
      case "/http-terminal-accepted-policy":
      case "/http-terminal-conflict-policy":
      case "/http-terminal-external-policy": {
        const path = new URL(request.url).pathname;
        const mode = path.includes("accepted")
          ? "accepted"
          : path.includes("conflict")
            ? "conflict"
            : "external";
        return policy(env, terminalPolicySource(mode), {
          NEXT: (ctx.exports as unknown as ProbeExports).FetchNext({ props: {} }),
        }).fetch(clean(request));
      }
      case "/http-terminal-accepted-reentrant-policy":
      case "/http-terminal-accepted-reentrant-app-host":
      case "/http-terminal-accepted-reentrant-policy-host":
      case "/http-terminal-accepted-reentrant-pipe":
      case "/http-terminal-slow-reentrant-pipe":
      case "/http-terminal-gzip-reentrant-pipe":
      case "/http-terminal-gzip-reentrant-raw":
      case "/reentrant-pipe-socket": {
        const path = new URL(request.url).pathname;
        const appHost = path.endsWith("app-host");
        const policyHost = path.endsWith("policy-host");
        const pipe = path.includes("reentrant-pipe");
        const slow = path.includes("terminal-slow");
        const gzip = path.includes("terminal-gzip");
        const exports = ctx.exports as unknown as ProbeExports;
        const host = policyHost
          ? exports.ReentryHost({ props: { policyHost: true, slow } })
          : undefined;
        const props = {
          reentry: true,
          ...(appHost && { appHost: true }),
          ...(policyHost && { policyHost: true }),
          ...(pipe && { pipe: true }),
          ...(slow && { slow: true }),
          ...(gzip && { gzip: true }),
        };
        return policy(
          env,
          reentrantPolicySource,
          { NEXT: exports.FetchNext({ props }) },
          host,
        ).fetch(clean(request));
      }
      default:
        return Promise.resolve(new Response("not found", { status: 404 }));
    }
  },
};
