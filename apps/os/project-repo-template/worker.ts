import { WebClient } from "@slack/web-api";
import { IterateProjectWorker, type DynamicWorkerRef, type StreamEvent } from "./sdk.ts";
import { slackConfig } from "./slack.config.ts";
import { waitroseClient } from "./integrations/waitrose/client.ts";

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
      files: { type: "repo", repoPath: "/", include: ["apps/hello/**", "sdk.ts"] },
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

export default class ProjectWorker extends IterateProjectWorker {
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

  override async processEvent(event: StreamEvent): Promise<void> {
    // React to anything happening anywhere in the project. For example:
    //
    //   if (
    //     event.path === "/integrations/email" &&
    //     event.type === "events.iterate.com/email/received"
    //   ) {
    //     const itx = await this.env.ITX.get();
    //     await itx.streams.get("/mailroom").append({
    //       type: "events.iterate.com/test/mail-logged",
    //       idempotencyKey: `mail-logged:${event.path}@${event.offset}`,
    //       payload: { subject: event.payload?.subject ?? null },
    //     });
    //   }
    console.log("project event", event.path, event.type);
  }

  /**
   * The platform dispatches dotted calls on this worker as ONE flattened
   * `invokeCapability({ path, args })` call, and this userspace method walks
   * the path over the worker itself. That is what lets the `slack` getter
   * below hand back the raw SDK client: nothing ever crosses RPC except the
   * final method's arguments and result, so
   * `itx.worker.slack.chat.postMessage({...})` — or any nested Web API
   * family — is a single round trip into plain userland code.
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
   * Slack Web API surface: the real `@slack/web-api` SDK from package.json,
   * configured by committing slack.config.ts. Only ever reached through the
   * userspace `invokeCapability` walk above, so the client needs no RPC-safe
   * projection.
   */
  get slack(): WebClient {
    const client = new WebClient(slackConfig.token ?? undefined, {
      ...(slackConfig.slackApiUrl === null ? {} : { slackApiUrl: slackConfig.slackApiUrl }),
    });
    // The SDK's axios defaults to its node-http adapter, whose response
    // handling hangs under the Workers runtime; the fetch adapter rides the
    // platform's native fetch (and therefore project egress) instead.
    (client as unknown as { axios: { defaults: { adapter: string } } }).axios.defaults.adapter =
      "fetch";
    return client;
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
