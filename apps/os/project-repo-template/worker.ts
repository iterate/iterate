import { WorkerEntrypoint } from "cloudflare:workers";
import type { DynamicWorkerRef, ItxBinding, StreamEvent } from "iterate/sdk";
import { waitroseClient } from "./integrations/waitrose/client.ts";

/** Bindings the platform supplies to every project worker. `ItxBinding`
 * (iterate/sdk) documents the two channels: `get()` for capability method
 * calls, `fetch()` for HTTP into sibling workers. */
type ProjectWorkerEnv = {
  ITX: ItxBinding;
};

// The root project worker is a small ROUTER over the project's apps. Each app
// is its own repo-backed dynamic worker built from this repo (multi-file
// TypeScript — the build pipeline bundles the masked file snapshot); ingress
// selects one via the trusted x-iterate-app header (hosts like
// hello--<slug>.<base> or <app>.<custom-hostname>). Requests with no app
// selected get the static homepage below.
const APPS = {
  hello: {
    type: "stateless",
    path: "/",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/hello/**"] },
      options: { entryPoint: "apps/hello/worker.ts" },
    },
  },
  counter: {
    type: "stateful",
    path: "/",
    className: "CounterApp",
    durableWorkerKey: "app-counter",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/counter/**"] },
      options: { entryPoint: "apps/counter/worker.ts" },
    },
  },
  websocket: {
    type: "stateful",
    path: "/",
    className: "WebsocketEchoApp",
    durableWorkerKey: "app-websocket",
    source: {
      files: { type: "repo", repoPath: "/", include: ["apps/websocket/**"] },
      options: { entryPoint: "apps/websocket/worker.ts" },
    },
  },
} satisfies Record<string, DynamicWorkerRef>;

export default class ProjectWorker extends WorkerEntrypoint<ProjectWorkerEnv> {
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

  processEvent(input: { event: StreamEvent }): void {
    console.log("project worker processed", input.event.type);
  }

  /**
   * The platform dispatches dotted calls on this worker as ONE flattened
   * `invokeCapability({ path, args })` call, and this userspace method walks
   * the path over the worker itself. That is what lets the `waitrose` getter
   * below hand back a raw vendored client: nothing ever crosses RPC except
   * the final method's arguments and result, so
   * `itx.worker.waitrose.<connection>.<method>(...)` — or any nested surface
   * a getter returns — is a single round trip into plain userland code.
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

  /**
   * Waitrose surface (the reference userspace integration): the vendored
   * client from integrations/waitrose/client.ts, one per connection —
   * `itx.worker.waitrose.<connection>.<method>(...)`. Durable by
   * construction: this worker always exists and is late-bound to the repo,
   * so there is no mount step and nothing session-owned to expire. The
   * bearer is a `getSecret(...)` placeholder substituted at project egress;
   * this code never sees a session token (the secret's own Durable Object
   * logs in on first use and re-logins on 401 — see the README there).
   */
  get waitrose(): Record<string, ReturnType<typeof waitroseClient>> {
    return new Proxy({} as Record<string, ReturnType<typeof waitroseClient>>, {
      get: (_target, connection) =>
        // "then" guard: the dispatch walk awaits each segment, and awaiting
        // the proxy itself must not conjure a client named "then".
        typeof connection !== "string" || connection === "then"
          ? undefined
          : waitroseClient({
              authorization: `Bearer getSecret({ path: "/secrets/integrations/waitrose/${connection}/session", field: "accessToken" })`,
            }),
    });
  }
}
