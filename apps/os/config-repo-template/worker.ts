import {
  IterateDurableObject,
  IterateWorkerEntrypoint,
  createStreamProcessorHost,
  type DynamicWorkerRef,
  type Project,
  type StreamEvent,
  type StreamProcessorAlarmInfo,
  type StreamProcessorHost,
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/sdk";
import {
  GITHUB_REVIEW_SUBSCRIPTION_KEY,
  GithubReviewProcessor,
  GithubReviewProcessorContract,
  githubReviewTarget,
  type GithubReviewConfig,
  type GithubReviewRule,
} from "./github-reviews.ts";

// Pull-request reviews are project userspace, not platform policy. Keep this
// list empty to disable them; add exact "owner/repo" names to review every
// opened, ready, or pushed non-draft head in those repositories. The labels
// provide per-PR controls using GitHub's own permissions.
const GITHUB_REVIEW_RULES = [
  {
    id: "structure/no-small-single-use-helper",
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    invariant:
      "Do not introduce a small helper used only once when keeping the logic at its call site would be clearer.",
  },
  {
    id: "typescript/no-inferable-type-annotation",
    files: ["**/*.{ts,tsx,mts,cts}"],
    invariant:
      "Do not declare a type annotation when TypeScript already infers the intended type precisely.",
  },
  {
    id: "typescript/explain-type-cast",
    files: ["**/*.{ts,tsx,mts,cts}"],
    invariant:
      "Every type cast must have a nearby explanation of why the cast is safe and cannot reasonably be avoided.",
  },
] satisfies readonly GithubReviewRule[];

const GITHUB_REVIEWS = {
  forceLabel: "iterate:review",
  osBaseUrl: "https://os.iterate.com",
  repositories: Array<string>(),
  rules: GITHUB_REVIEW_RULES,
  skipLabel: "iterate:skip-review",
  timeoutSeconds: 30 * 60,
} satisfies GithubReviewConfig;

const GITHUB_REVIEW_COORDINATES_KEY = "github-review/stream";

type GithubReviewCoordinates = {
  path: string;
  projectId: string;
};

// The root project worker (default export) routes HTTP and reacts to project
// events, and the example apps are named exports — a stateless HelloApp and a
// stateful CounterApp with live WebSocket updates. Review POLICY stays visible
// above; its safety-critical mechanics are isolated in github-reviews.ts so
// they can be tested. Both apps build from THIS file with a different entry
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

  // The base class delivers every committed event on every stream in this
  // project here, one call per event — in per-stream order, at-least-once
  // (its docstring has the full contract). React with one `if` per reaction,
  // keyed on event.path + event.type; anything a reaction appends should
  // carry an idempotency key.
  async processEvent(event: StreamEvent): Promise<void> {
    // THIS WORKER configures new agents. When any stream under /agents/ is
    // born (a web chat, the onboarding agent, a chat or email thread), the
    // platform announces it on the project root stream and this
    // reaction appends the agent's policy: system prompt, model,
    // capability mounts, boot context. `itx.agents.defaults.forPath` returns
    // the platform's defaults as data — edit the result (or pass prompt/model
    // overrides) to change how YOUR agents behave. GitHub review automation
    // is a separate userspace StreamProcessor attached below when an eligible
    // routed webhook first reaches its canonical pull-request stream.
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

    if (event.type === "events.iterate.com/github/webhook-received") {
      const target = githubReviewTarget(event, GITHUB_REVIEWS);
      if (target === null || !GITHUB_REVIEWS.repositories.includes(target.fullName)) return;

      // One stateful dynamic-worker identity per canonical PR stream. The
      // stream owns delivery; this worker only declares where its userspace
      // processor's wake door lives. A new push interrupts the same PR agent
      // conversation and reuses the same processor checkpoint.
      const reviewProcessorRef = {
        type: "stateful",
        path: event.path,
        className: "GithubReviewProcessorDurableObject",
        durableWorkerKey: "github-review-processor",
        source: {
          files: { type: "repo", repoPath: "/repos/config" },
          options: { entryPoint: "worker.ts" },
        },
      } satisfies DynamicWorkerRef;
      const itx = await this.env.ITX.get();
      try {
        await itx.streams.get(event.path).append({
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `github-review/subscription@${event.path}`,
          payload: {
            subscriptionKey: GITHUB_REVIEW_SUBSCRIPTION_KEY,
            delivery: {
              mode: "wake",
              expression: ["workers", ["get", reviewProcessorRef], "wakeStreamSubscriber"],
              processorSlug: GithubReviewProcessorContract.slug,
            },
            params: {
              initialRequest: { sourceOffset: event.offset, target },
            },
          },
        });
      } finally {
        try {
          itx[Symbol.dispose]?.();
        } catch {}
      }
    }
  }
}

/**
 * General stream-processor hosting, entirely in project userspace. The
 * platform's stateful dynamic-worker host supplies the Durable Object; this
 * class supplies the ordinary processor host, processor, and wake/alarm
 * methods expected by a wake-mode stream subscription.
 */
export class GithubReviewProcessorDurableObject extends IterateDurableObject {
  #hosted: Promise<{ host: StreamProcessorHost; itx: Project }> | undefined;

  async wakeStreamSubscriber(
    request: StreamSubscriberWakeRequest,
  ): Promise<StreamSubscriberWakeResponse> {
    const { host } = await this.#processorHost(this.#coordinates(request));
    return await host.wakeStreamSubscriber(request);
  }

  async alarm(alarmInfo?: StreamProcessorAlarmInfo): Promise<void> {
    const { host } = await this.#processorHost(this.#coordinates());
    await host.handleAlarm(alarmInfo);
  }

  #coordinates(request?: StreamSubscriberWakeRequest): GithubReviewCoordinates {
    const stored = this.ctx.storage.kv.get<GithubReviewCoordinates>(GITHUB_REVIEW_COORDINATES_KEY);
    if (request === undefined) {
      if (stored === undefined) {
        throw new Error("GitHub review processor alarm fired before its first stream wake");
      }
      return stored;
    }
    if (request.stream.projectId === null) {
      throw new Error("GitHub review processors require a project-scoped stream");
    }
    const requested = {
      path: request.stream.path,
      projectId: request.stream.projectId,
    };
    if (
      stored !== undefined &&
      (stored.path !== requested.path || stored.projectId !== requested.projectId)
    ) {
      throw new Error(
        `GitHub review processor is bound to ${stored.projectId}:${stored.path}, not ${requested.projectId}:${requested.path}`,
      );
    }
    if (stored === undefined) this.ctx.storage.kv.put(GITHUB_REVIEW_COORDINATES_KEY, requested);
    return requested;
  }

  async #processorHost(
    coordinates: GithubReviewCoordinates,
  ): Promise<{ host: StreamProcessorHost; itx: Project }> {
    if (this.#hosted !== undefined) return await this.#hosted;
    const creating = (async () => {
      const itx = await this.env.ITX.get();
      try {
        const projectId = await itx.projectId;
        if (projectId !== coordinates.projectId) {
          throw new Error(
            `GitHub review processor project mismatch: ${projectId} !== ${coordinates.projectId}`,
          );
        }
        const host = createStreamProcessorHost(this.ctx, {
          path: coordinates.path,
          projectId: coordinates.projectId,
          stream: itx.streams.get(coordinates.path),
          version: GithubReviewProcessorContract.version,
        });
        host.add(
          (deps) =>
            new GithubReviewProcessor({
              ...deps,
              config: GITHUB_REVIEWS,
              itx,
            }),
        );
        // The processor performs later GitHub and scheduler calls, so this
        // Project stub intentionally stays owned by the host for the lifetime
        // of the Durable Object incarnation.
        return { host, itx };
      } catch (error) {
        try {
          itx[Symbol.dispose]?.();
        } catch {}
        throw error;
      }
    })();
    this.#hosted = creating;
    try {
      return await creating;
    } catch (error) {
      if (this.#hosted === creating) this.#hosted = undefined;
      throw error;
    }
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
