import { IterateDurableObject, IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { processGithubReviewEvent } from "./github-reviews.ts";

// Pull-request reviews are project userspace, not platform policy. Keep this
// list empty to disable them; add exact "owner/repo" names to review every
// opened, ready, or pushed non-draft head in those repositories. The labels
// provide per-PR controls using GitHub's own permissions.
const GITHUB_REVIEWS = {
  forceLabel: "iterate:review",
  osBaseUrl: "https://os.iterate.com",
  repositories: [] as string[],
  rulesPath: "agents/github-review.md",
  skipLabel: "iterate:skip-review",
  timeoutSeconds: 30 * 60,
};

// The root project worker (default export) routes HTTP and reacts to project
// events, and the example apps are named exports — stateless HelloApp and
// InternalApp plus stateful CounterApp. Review POLICY stays visible
// above; its safety-critical mechanics are isolated in github-reviews.ts so
// they can be tested. All three apps build from THIS file with a different entry
// class; split an app into its own file when it earns one.
//
// Everything extends the iterate/sdk base classes — IterateWorkerEntrypoint
// (stateless) and IterateDurableObject (stateful) — which carry the platform
// surface: `processEventBatch`/`processEvent` (event delivery — override
// `processEvent` to react), `invokeCapability` (flattened `itx.worker.<path>`
// dispatch — any getter or method you add becomes a capability surface), and
// `fetchDynamicWorker` (HTTP into sibling workers, WebSockets included). Env
// defaults to `{ ITX: ItxBinding }`, the one binding the platform supplies.

export default class ProjectWorker extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    // Each app is a repo-backed dynamic worker; ingress selects one via the
    // trusted x-iterate-app header (hosts like hello--<slug>.<base> or
    // <app>.<custom-hostname>). Requests with no app selected get the static
    // homepage below. `fetchDynamicWorker` dispatches over the platform's
    // fetch-native worker lane — its docstring explains why app HTTP must
    // ride a real fetch hop, never an RPC method call.
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
    if (app === "internal") {
      return this.fetchDynamicWorker(req, {
        type: "stateless",
        path: "/",
        entrypoint: "InternalApp",
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
                <li><a href="${appUrl("internal")}">internal</a> (project members only)</li>
                <li><a href="${appUrl("counter")}">counter</a> (stateful)</li>
              </ul>
              <p>Edit worker.ts in the project repo to change this.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  // The base class delivers every committed event on every stream in this
  // project here, one call per event — in per-stream order, at-least-once
  // (its docstring has the full contract). React with one `if` per reaction,
  // keyed on event.path + event.type; anything a reaction appends should
  // carry an idempotency key.
  async processEvent(event: StreamEvent): Promise<void> {
    if (event.type === "events.iterate.com/github/webhook-received") {
      using itx = await this.env.ITX.get();
      await processGithubReviewEvent({ config: GITHUB_REVIEWS, event, itx });
    }
  }
}

// A stateless app the root project worker routes to when ingress selects the
// "hello" app. It gets the full project itx through env.ITX, and the same
// base-class surface as the root worker — add a getter here and it's an
// `itx.worker` capability on THIS app via `itx.workers.get(ref)`.
export class HelloApp extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const description = await itx.__describe();
    return Response.json({
      app: "hello",
      path: new URL(req.url).pathname,
      projectId: description.projectId,
    });
  }
}

// A project-member-only app. Auth is a partial fetch: return its response when
// non-null, and continue the app only when it returns null.
export class InternalApp extends IterateWorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const auth = await itx.auth.get({ policy: "project-member" }).fetch(request);
    if (auth) return auth;

    // A null auth result leaves the original request untouched, so normal app
    // routes can still read its body. This echo route makes that contract easy
    // to exercise in the seeded browser proof.
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/echo") {
      return new Response(await request.text(), {
        headers: { "cache-control": "no-store", "content-type": "text/plain" },
      });
    }

    const snapshot = await itx.processor.snapshot();
    const events = await itx.streams.get("/").getEvents({
      afterOffset: Math.max(0, snapshot.offset - 25),
      limit: 25,
    });
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Project events</title></head><body><main><h1>Latest project root events</h1><form action="/_iterate/auth/logout" method="post"><button>Sign out</button></form><pre>${escapeHtml(JSON.stringify(events.slice().reverse(), null, 2))}</pre></main></body></html>`,
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }
}

// A stateful app: a Durable Object hosted as a repo-backed stateful dynamic
// worker. State survives across requests under its durableWorkerKey, and
// every open page gets live updates over a WebSocket. The /ws upgrade's 101
// response reaches this Durable Object over the platform's fetch-native
// worker lane (the ProjectWorker router above, via `fetchDynamicWorker`) —
// an `app.fetch(req)` RPC method call could not carry a socket. Copy this
// shape for anything real-time.
export class CounterApp extends IterateDurableObject {
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
