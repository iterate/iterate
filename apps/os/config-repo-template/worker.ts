import {
  IterateDurableObject,
  IterateWorkerEntrypoint,
  itxProjectStream,
  type StreamEvent,
} from "iterate/sdk";
import {
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { processGithubReviewEvent } from "./github-reviews.ts";
import {
  guestbookAppRef,
  guestbookCreationEvents,
  GuestbookProcessor,
  guestbookStreamPath,
} from "./guestbook.ts";

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
// events, and the example apps are named exports — a stateless HelloApp, a
// stateful CounterApp with live WebSocket updates, and GuestbookApp, whose
// state is a stream-processor fold of durable events (see guestbook.ts).
// Review POLICY stays visible above; its safety-critical mechanics are
// isolated in github-reviews.ts so they can be tested. All apps build from
// THIS file with a different entry class; split an app into its own file when
// it earns one.
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
    if (app === "guestbook") {
      return this.fetchDynamicWorker(req, guestbookAppRef);
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
                <li><a href="${appUrl("guestbook")}">guestbook</a> (stream processor)</li>
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
      const itx = await this.env.ITX.get();
      try {
        await processGithubReviewEvent({ config: GITHUB_REVIEWS, event, itx });
      } finally {
        try {
          itx[Symbol.dispose]?.();
        } catch {}
      }
    }
    // The guestbook needs no lane here: its events reach GuestbookApp through
    // the durable WAKE subscription its creation batch configures (see
    // guestbookCreationEvents) — the stream spine dials the app directly.
  }
}

// A stateless app the root project worker routes to when ingress selects the
// "hello" app. It gets the full project itx through env.ITX, and the same
// base-class surface as the root worker — add a getter here and it's an
// `itx.worker` capability on THIS app via `project.workers.get(ref)`.
export class HelloApp extends IterateWorkerEntrypoint {
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

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// A stream-processor-backed app: where CounterApp keeps its number in Durable
// Object storage, the guestbook's state is a FOLD of durable events on the
// project stream at /guestbook, driven by the platform's own processor
// machinery (`iterate/processors`; the processor + contract live in
// guestbook.ts). This Durable Object is only the HOST: it wires a registry to
// an itx-dialed stream handle, and the stream's own delivery spine wakes it —
// the creation batch (guestbookCreationEvents) configures a durable wake
// subscription whose expression names this app's `processor` getter, so the
// platform performs the same handshake here that it performs against its own
// domain Durable Objects and pushes event frames straight into the runner.
// Delete this object's storage and replay rebuilds everything.
export class GuestbookApp extends IterateDurableObject {
  #host: { guestbook: GuestbookProcessor; registry: StreamProcessorRegistry } | undefined;

  // Hosting is constructed lazily, not in the constructor: the registry and
  // the processor's provenance stamps need the owning project's id, which
  // arrives with the wake request or is read from __describe on first fetch.
  #ensureHost(projectId: string): {
    guestbook: GuestbookProcessor;
    registry: StreamProcessorRegistry;
  } {
    if (this.#host === undefined) {
      const stream = itxProjectStream(this.env, guestbookStreamPath);
      const registry = createStreamProcessorRegistry(this.ctx, {
        path: guestbookStreamPath,
        projectId,
        stream,
        version: "0",
      });
      const guestbook = registry.register(
        // NO `{ recovery: true }`: keepalive recovery arms durable alarms,
        // and workerd does not implement alarms on the facet storage that
        // hosts stateful dynamic workers ("alarms are not yet implemented
        // for SQLite-backed Durable Objects") — arming would fail every
        // delivery. Fine for the guestbook: its only side effect is an
        // idempotency-keyed at-head append, re-derived on the next delivery,
        // so nothing is owed across an eviction. Processors with
        // consequential background obligations need a platform-hosted DO
        // until facet alarms ship; then this becomes
        // `registry.register(processor, { recovery: true })` plus an
        // `alarm()` method routing to `registry.handleAlarm`.
        new GuestbookProcessor({ path: guestbookStreamPath, projectId, stream }),
      );
      this.#host = { guestbook, registry };
    }
    return this.#host;
  }

  /** The wake door the stream spine dials — the subscription's persisted
   * expression is `workers.get(ref).processor.wakeStreamSubscriber`, which
   * the platform's dynamic capability dispatch flattens into an
   * invokeCapability walk that lands here. The request carries the stream's
   * coordinates, so the host can construct itself before answering the
   * handshake (checkpoint + a live sink the stream then delivers frames to). */
  get processor() {
    return {
      wakeStreamSubscriber: async (
        request: StreamSubscriberWakeRequest,
      ): Promise<StreamSubscriberWakeResponse> => {
        if (request.stream.projectId === null) {
          throw new Error("the guestbook subscribes on project streams only");
        }
        const { registry } = this.#ensureHost(request.stream.projectId);
        return await registry.wakeStreamSubscriber(request);
      },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const prefix = req.headers.get("x-iterate-url-prefix") ?? "";
    const url = new URL(req.url);
    const project = await this.env.ITX.get();
    try {
      // Awaited on purpose: `project` is an RPC stub, so the property read is
      // a promise — and #ensureHost caches its first construction, so passing
      // it unawaited would permanently wire the host with a non-string id.
      const { guestbook, registry } = this.#ensureHost(await project.projectId);

      if (req.method === "POST" && url.pathname === "/sign") {
        const form = await req.formData();
        const name = String(form.get("name") ?? "").trim();
        const message = String(form.get("message") ?? "").trim();
        if (name !== "" && message !== "") {
          // One atomic batch: the idempotency-keyed creation events (birth +
          // wake subscription — every signer offers them; the stream dedupes
          // to one of each) plus this entry. Raw appends — the app is the
          // CREATOR here; the processor only ever emits milestone facts.
          await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents(), {
            type: "events.iterate.com/guestbook/entry-signed",
            payload: { message, name },
            idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
          });
        }
        return new Response(null, { headers: { location: `${prefix}/` }, status: 303 });
      }

      // Read-your-writes before every render: wake delivery is asynchronous,
      // so pull the runner to head, then read the fold through the
      // registry's runner-backed snapshot.
      await registry.catchUp("guestbook");
      const { state } = await registry.reads(guestbook).snapshot();
      const title = escapeHtml(state.birthCertificate?.config.title ?? "Guestbook");
      const entries = state.entries
        .map(
          (entry) =>
            `<li><strong>${escapeHtml(entry.name)}</strong>: ${escapeHtml(entry.message)}</li>`,
        )
        .join("\n");
      return new Response(
        `<!doctype html>
          <html>
            <body>
              <main>
                <h1>${title}</h1>
                <p>${state.entries.length} signatures — last milestone: ${state.lastMilestone}</p>
                <ul>${entries}</ul>
                <form method="post" action="${prefix}/sign">
                  <input name="name" placeholder="name" required />
                  <input name="message" placeholder="message" required />
                  <button>sign</button>
                </form>
              </main>
            </body>
          </html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    } finally {
      try {
        project[Symbol.dispose]?.();
      } catch {}
    }
  }
}
