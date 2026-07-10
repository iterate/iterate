import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DynamicWorkerRef, ItxBinding, StreamEvent, StreamEventBatch } from "iterate/sdk";

// The whole seeded worker in ONE file, so reading this module is reading the
// whole system: the root project worker (default export) routes HTTP and
// reacts to project events, and the three example apps are named exports —
// a stateless WorkerEntrypoint (HelloApp), a stateful Durable Object
// (CounterApp), and a WebSocket Durable Object (WebsocketEchoApp). Each APPS
// entry below builds from THIS file with a different entry class; split an
// app into its own file (and point its ref's entryPoint at it) when it earns
// one.

/** Bindings the platform supplies to every project worker. `ItxBinding`
 * (iterate/sdk) documents the two channels: `get()` for capability method
 * calls, `fetch()` for HTTP into sibling workers. */
type Env = { ITX: ItxBinding };

// The root project worker is a small ROUTER over the project's apps. Each app
// is its own repo-backed dynamic worker (here: a different exported class of
// this same module); ingress selects one via the trusted x-iterate-app header
// (hosts like hello--<slug>.<base> or <app>.<custom-hostname>). Requests with
// no app selected get the static homepage below.
const APPS = {
  hello: {
    type: "stateless",
    path: "/",
    entrypoint: "HelloApp",
    source: {
      files: { type: "repo", repoPath: "/repos/config" },
      options: { entryPoint: "worker.ts" },
    },
  },
  counter: {
    type: "stateful",
    path: "/",
    className: "CounterApp",
    durableWorkerKey: "app-counter",
    source: {
      files: { type: "repo", repoPath: "/repos/config" },
      options: { entryPoint: "worker.ts" },
    },
  },
  websocket: {
    type: "stateful",
    path: "/",
    className: "WebsocketEchoApp",
    durableWorkerKey: "app-websocket",
    source: {
      files: { type: "repo", repoPath: "/repos/config" },
      options: { entryPoint: "worker.ts" },
    },
  },
} satisfies Record<string, DynamicWorkerRef>;

export default class ProjectWorker extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    const appSlug = req.headers.get("x-iterate-app");
    if (appSlug) {
      const ref = Object.hasOwn(APPS, appSlug) ? APPS[appSlug as keyof typeof APPS] : undefined;
      if (!ref) return new Response(`unknown app: ${appSlug}`, { status: 404 });

      // Every app request — pages, APIs, streaming bodies, WebSocket upgrades
      // — dispatches over the platform's fetch-native worker lane:
      // `env.ITX.fetch` with the target ref in the x-iterate-worker-dispatch
      // header (JSON { ref, buildBudgetMs? } — same ref shape as
      // project.workers.get). Real fetch hops are what let a 101 upgrade
      // tunnel through; an `app.fetch(req)` RPC method call cannot carry one.
      // A cold build answers a 503 building page that refreshes itself
      // (marked with x-iterate-worker-building — intercept it here to render
      // your own). Method calls on apps still go through
      // `project.workers.get(ref)` RPC dispatch; HTTP never does.
      const headers = new Headers(req.headers);
      headers.set("x-iterate-worker-dispatch", JSON.stringify({ buildBudgetMs: 15_000, ref }));
      return await this.env.ITX.fetch(new Request(req, { headers }));
    }

    // The seeded homepage is a static page linking to the apps. Platform
    // hosts use "<app>--<project>.<base>"; custom domains use
    // "<app>.<custom-hostname>".
    const url = new URL(req.url);
    const hostKind = req.headers.get("x-iterate-host-kind");
    const appLinks = Object.entries(APPS)
      .map(([slug, ref]) => {
        const appHost = hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`;
        const href = `${url.protocol}//${appHost}/`;
        return `<li><a href="${href}">${slug}</a> (${ref.type})</li>`;
      })
      .join("\n");
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from your Iterate project worker.</p>
              <ul>${appLinks}</ul>
              <p>Edit worker.ts in the project repo to change this.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
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
        const itx = await this.env.ITX.get();
        const defaults = await itx.agents.defaults.forPath(childPath);
        await itx.streams.get(childPath).append(...defaults.events);
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
    const description = await project.__describe();
    return Response.json({
      app: "hello",
      path: new URL(req.url).pathname,
      projectId: description.projectId,
    });
  }
}

// A stateful app: a Durable Object class hosted as a repo-backed stateful
// dynamic worker. State survives across requests under its durableWorkerKey.
export class CounterApp extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    // The path lane advertises its stripped URL prefix; host lanes have none.
    const prefix = req.headers.get("x-iterate-url-prefix") ?? "";
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/increment") {
      await this.increment();
      // Redirect back so the browser URL never sticks at /increment.
      return new Response(null, { status: 303, headers: { location: `${prefix}/` } });
    }

    const count = await this.current();
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>count: ${count}</p>
              <form method="post" action="${prefix}/increment">
                <button type="submit">increment</button>
              </form>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  async increment(): Promise<number> {
    const n = (this.ctx.storage.kv.get<number>("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return n;
  }

  async current(): Promise<number> {
    return this.ctx.storage.kv.get<number>("n") ?? 0;
  }
}

// The seeded WebSocket proof-of-concept: a stateful app whose Durable Object
// holds every live socket and relays messages between them. Connect to /ws,
// send a text frame, and the app echoes it back (`echo:<text>`) and forwards
// it to every other connected client (`peer:<text>`). The homepage is a tiny
// chat page exercising exactly that.
//
// All app HTTP — including the /ws upgrade below — reaches this Durable
// Object over the platform's fetch-native worker lane (see the router in
// ProjectWorker.fetch: `this.env.ITX.fetch(...)` with the app's ref in the
// x-iterate-worker-dispatch header). That lane is what lets the 101 response
// carry its socket; an `app.fetch(req)` RPC method call could not.
export class WebsocketEchoApp extends DurableObject {
  private sockets = new Set<WebSocket>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.acceptSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/health") {
      return Response.json({ connections: this.sockets.size, ok: true });
    }

    return new Response(WEBSOCKET_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Named to avoid the DurableObject base class's `connect(socket)` TCP
  // handler, which this would otherwise override with the wrong signature.
  private acceptSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);

    ws.addEventListener("message", (event) => {
      const text = String(event.data ?? "");
      ws.send(`echo:${text}`);
      for (const peer of this.sockets) {
        if (peer !== ws) peer.send(`peer:${text}`);
      }
    });

    const drop = () => this.sockets.delete(ws);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }
}

const WEBSOCKET_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>websocket echo</title>
</head>
<body>
  <main>
    <p>WebSocket echo: messages come back as <code>echo:</code>, other tabs see <code>peer:</code>.</p>
    <p id="status">connecting…</p>
    <form id="form"><input id="input" autocomplete="off" placeholder="say something"><button>send</button></form>
    <pre id="log"></pre>
  </main>
  <script>
    const status = document.getElementById("status");
    const log = document.getElementById("log");
    let ws;
    function connect() {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
      ws.onopen = () => { status.textContent = "connected"; };
      ws.onmessage = (event) => { log.textContent += event.data + "\\n"; };
      ws.onclose = () => { status.textContent = "reconnecting…"; setTimeout(connect, 1000); };
    }
    document.getElementById("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("input");
      if (ws && ws.readyState === WebSocket.OPEN && input.value) ws.send(input.value);
      input.value = "";
    });
    connect();
  </script>
</body>
</html>`;
