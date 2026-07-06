import { WorkerEntrypoint } from "cloudflare:workers";
import { WebClient } from "@slack/web-api";
import type { DynamicWorkerRef, Project, StreamEvent } from "./sdk.ts";
import { slackConfig } from "./slack.config.ts";

/** Bindings the platform supplies to every project worker. */
type ProjectWorkerEnv = {
  ITX: { get(): Promise<Project> };
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
} satisfies Record<string, DynamicWorkerRef>;

export default class ProjectWorker extends WorkerEntrypoint<ProjectWorkerEnv> {
  async fetch(req: Request): Promise<Response> {
    const appSlug = req.headers.get("x-iterate-app");
    if (appSlug) {
      const ref = Object.hasOwn(APPS, appSlug) ? APPS[appSlug as keyof typeof APPS] : undefined;
      if (!ref) return new Response(`unknown app: ${appSlug}`, { status: 404 });
      const project = await this.env.ITX.get();
      try {
        // Workers RPC: await the capability before calling through it.
        const app = await project.workers.get<{ fetch(req: Request): Promise<Response> }>(ref, {
          buildBudgetMs: 15_000,
        });
        return await app.fetch(req);
      } catch (error) {
        // Each app is its own build (distinct include mask), so its first use
        // after a commit can be a cold build. Past the budget the platform
        // throws this named error (name survives Workers RPC) while the build
        // finishes into the cache; refreshes then hit it.
        if ((error as { name?: string } | null)?.name !== "WorkerBuildInProgressError") throw error;
        return new Response(
          `<!doctype html><html><body><main><p>Building ${appSlug}… this page refreshes automatically.</p></main></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8", refresh: "3" }, status: 503 },
        );
      }
    }

    // The seeded homepage is a static page linking to the apps. Apps live
    // on their own hosts: the current host prefixed with "<app>--" (e.g.
    // counter--<slug>.<base>), so the links derive from the request URL.
    const url = new URL(req.url);
    const appLinks = Object.entries(APPS)
      .map(([slug, ref]) => {
        const href = `${url.protocol}//${slug}--${url.host}/`;
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
}
