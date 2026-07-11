import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DynamicWorkerRef, ItxBinding, StreamEvent, StreamEventBatch } from "iterate/sdk";

// The whole seeded worker in ONE file, so reading this module is reading the
// whole system: the root project worker (default export) routes HTTP and
// reacts to project events, and the example apps are named exports — a
// stateless WorkerEntrypoint (HelloApp) and a stateful Durable Object with
// live WebSocket updates (CounterApp). Both apps build from THIS file with a
// different entry class; split an app into its own file (and point its ref's
// entryPoint at it) when it earns one.

/** Bindings the platform supplies to every project worker. `ItxBinding`
 * (iterate/sdk) documents the two channels: `get()` for capability method
 * calls, `fetch()` for HTTP into sibling workers. */
type Env = { ITX: ItxBinding };

export default class ProjectWorker extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    // Each app is a repo-backed dynamic worker; ingress selects one via the
    // trusted x-iterate-app header (hosts like hello--<slug>.<base> or
    // <app>.<custom-hostname>). Requests with no app selected get the static
    // homepage below.
    const app = req.headers.get("x-iterate-app");
    if (app === "hello") {
      return this.fetchDynamicWorker(req, {
        type: "stateless",
        path: "/",
        entrypoint: "HelloApp",
        source: {
          files: { type: "repo", repoPath: "/repos/config" },
          options: { entryPoint: "worker.ts" },
        },
      });
    }
    if (app === "counter") {
      return this.fetchDynamicWorker(req, {
        type: "stateful",
        path: "/",
        className: "CounterApp",
        durableWorkerKey: "app-counter",
        source: {
          files: { type: "repo", repoPath: "/repos/config" },
          options: { entryPoint: "worker.ts" },
        },
      });
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });

    // The seeded homepage is a static page linking to the apps. Platform
    // hosts use "<app>--<project>.<base>"; custom domains use
    // "<app>.<custom-hostname>".
    const url = new URL(req.url);
    const hostKind = req.headers.get("x-iterate-host-kind");
    const appUrl = (slug: string) =>
      `${url.protocol}//${hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`}/`;
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from your Iterate project worker.</p>
              <ul>
                <li><a href="${appUrl("hello")}">hello</a> (stateless)</li>
                <li><a href="${appUrl("counter")}">counter</a> (stateful)</li>
              </ul>
              <p>Edit worker.ts in the project repo to change this.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  /**
   * Every app request — pages, APIs, streaming bodies, WebSocket upgrades —
   * dispatches over the platform's fetch-native worker lane: `env.ITX.fetch`
   * with the target ref in the x-iterate-worker-dispatch header (JSON
   * { ref, buildBudgetMs? } — same ref shape as project.workers.get). Real
   * fetch hops are what let a 101 upgrade tunnel through; an `app.fetch(req)`
   * RPC method call cannot carry one. A cold build answers a 503 building
   * page that refreshes itself (marked with x-iterate-worker-building —
   * intercept it here to render your own). Method calls on apps still go
   * through `project.workers.get(ref)` RPC dispatch; HTTP never does.
   */
  private async fetchDynamicWorker(req: Request, ref: DynamicWorkerRef): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.set("x-iterate-worker-dispatch", JSON.stringify({ buildBudgetMs: 15_000, ref }));
    return await this.env.ITX.fetch(new Request(req, { headers }));
  }

  /**
   * The platform delivers every committed event on every stream in this
   * project as checkpointed per-stream batches — in per-stream order,
   * at-least-once. This unpacks them into one `processEvent(event)` call per
   * event; throwing (or a worker that fails to build) leaves that stream's
   * checkpoint in place and the whole batch is redelivered later, so return
   * normally to advance past events you don't care about.
   */
  async processEventBatch(batch: StreamEventBatch): Promise<void> {
    for (const event of batch.events) await this.processEvent(event);
  }

  async processEvent(event: StreamEvent): Promise<void> {
    // React to anything happening anywhere in the project: one `if` per
    // reaction, keyed on event.path + event.type. Delivery is at-least-once,
    // so anything a reaction appends carries an idempotency key.

    // THIS WORKER configures new agents. When any stream under /agents/ is
    // born (a web chat, the onboarding agent, a chat or email thread), the
    // platform announces it on the project root stream and this
    // reaction appends the agent's policy: system prompt, model,
    // capability mounts, boot context. `itx.agents.defaults.forPath` returns
    // the platform's defaults as data — edit the result (or pass overrides:
    // { systemPrompt, model }) to change how YOUR agents behave.
    if (event.path === "/" && event.type === "events.iterate.com/stream/child-stream-created") {
      const childPath = event.payload?.childPath;
      if (typeof childPath === "string" && childPath.startsWith("/agents/")) {
        // env.ITX.get() hands this isolate an RPC stub; releasing it when the
        // reaction ends keeps the runtime's "stub was not disposed" warning
        // out of the logs (one agent birth = one reaction). try/finally, not
        // a `using` declaration: this repo builds through the platform
        // bundler at target es2022, which cannot transform `using` yet.
        const itx = await this.env.ITX.get();
        try {
          const defaults = await itx.agents.defaults.forPath(childPath);
          await itx.streams.get(childPath).append(...defaults.events);
        } finally {
          // Guarded: stub disposal is contractually non-throwing, but a throw
          // HERE would reject processEvent AFTER the append side effect —
          // redelivery would then apply the defaults twice.
          try {
            itx[Symbol.dispose]?.();
          } catch {}
        }
      }
    }
  }

  /**
   * The platform dispatches dotted calls on this worker as ONE flattened
   * `invokeCapability({ path, args })` call, and this userspace method walks
   * the path over the worker itself. That is what lets a getter you add to
   * this class hand back a raw SDK client (say, a vendor SDK installed from
   * package.json): nothing ever crosses RPC except the final method's
   * arguments and result, so `itx.worker.<getter>.<method>({...})` — or any
   * nested surface a getter returns — is a single round trip into plain
   * userland code.
   */
  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    let receiver: unknown = this;
    for (const segment of path.slice(0, -1)) {
      receiver = await Reflect.get(Object(receiver), segment);
    }
    const method = path.at(-1)!;
    const handler = Reflect.get(Object(receiver), method);
    if (typeof handler !== "function") {
      throw new Error(`"${path.join(".")}" is not a method on this project worker`);
    }
    return await Reflect.apply(handler, receiver, args);
  }
}

// A stateless app: a plain WorkerEntrypoint the root project worker routes
// to when ingress selects the "hello" app. It still gets the full project
// itx through env.ITX.
export class HelloApp extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    const project = await this.env.ITX.get();
    try {
      const description = await project.__describe();
      return Response.json({
        app: "hello",
        path: new URL(req.url).pathname,
        projectId: description.projectId,
      });
    } finally {
      // Release the itx stub (see the processEvent comment above); guarded so
      // a throwing dispose can never mask the response.
      try {
        project[Symbol.dispose]?.();
      } catch {}
    }
  }
}

// A stateful app: a Durable Object class hosted as a repo-backed stateful
// dynamic worker. State survives across requests under its durableWorkerKey,
// and every open page gets live updates over a WebSocket. The /ws upgrade's
// 101 response reaches this Durable Object over the platform's fetch-native
// worker lane (the ProjectWorker router above: `this.env.ITX.fetch(...)` with
// the app's ref in the x-iterate-worker-dispatch header) — an `app.fetch(req)`
// RPC method call could not carry a socket. Copy this shape for anything
// real-time.
export class CounterApp extends DurableObject {
  private sockets = new Set<WebSocket>();

  async fetch(req: Request): Promise<Response> {
    // The path lane advertises its stripped URL prefix; host lanes have none.
    const prefix = req.headers.get("x-iterate-url-prefix") ?? "";
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const ws = pair[1];
      ws.accept();
      this.sockets.add(ws);
      const drop = () => this.sockets.delete(ws);
      ws.addEventListener("close", drop);
      ws.addEventListener("error", drop);
      // Greet every new socket with the current count, so a fresh tab is
      // correct before anyone clicks.
      ws.send(String(await this.current()));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (req.method === "POST" && url.pathname === "/increment") {
      return Response.json({ count: await this.increment() });
    }

    // A mini client-side app: the count renders server-side, the button
    // POSTs /increment, and the WebSocket pushes every new value to every
    // open tab. The button stays disabled — with a visible "connecting…"
    // state — until the socket is open, so a click always has a live update
    // lane and anyone (tests included) can SEE why the button isn't ready
    // yet.
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>count: <span id="n">${await this.current()}</span></p>
              <button id="b" disabled>increment</button>
              <p id="s">connecting…</p>
            </main>
            <script>
              const button = document.getElementById("b");
              button.onclick = () => fetch("${prefix}/increment", { method: "POST" });
              const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "${prefix}/ws");
              ws.onopen = () => { button.disabled = false; document.getElementById("s").remove(); };
              ws.onmessage = (event) => { document.getElementById("n").textContent = event.data; };
            </script>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  async increment(): Promise<number> {
    const n = (this.ctx.storage.kv.get<number>("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    for (const ws of this.sockets) ws.send(String(n));
    return n;
  }

  async current(): Promise<number> {
    return this.ctx.storage.kv.get<number>("n") ?? 0;
  }
}
