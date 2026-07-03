import { WorkerEntrypoint } from "cloudflare:workers";
import { WebClient } from "@slack/web-api";
import type { DynamicWorkerRef, Itx, StreamEvent } from "./itx.ts";
import { slackConfig } from "./slack.config.ts";

/** Bindings the platform supplies to every project worker. */
type ProjectWorkerEnv = {
  ITX: { get(): Promise<Itx> };
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
      files: { type: "repo", repoPath: "/", include: ["apps/hello/**", "itx.ts"] },
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
      const ref = APPS[appSlug as keyof typeof APPS];
      if (!ref) return new Response(`unknown app: ${appSlug}`, { status: 404 });
      const project = await this.env.ITX.get();
      // Workers RPC: await the capability before calling through it.
      const app = await project.workers.get<{ fetch(req: Request): Promise<Response> }>(ref);
      return await app.fetch(req);
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
   * Slack Web API surface: `itx.worker.slack.chat.postMessage({...})` (any
   * nested Web API method family works). This is plain userland code — the
   * real `@slack/web-api` SDK from package.json, configured by
   * slack.config.ts, projected into an RPC-safe shape.
   */
  get slack(): Record<string, unknown> {
    const client = new WebClient(slackConfig.token ?? undefined, {
      ...(slackConfig.slackApiUrl === null ? {} : { slackApiUrl: slackConfig.slackApiUrl }),
    });
    // The SDK's axios defaults to its node-http adapter, whose response
    // handling hangs under the Workers runtime; the fetch adapter rides the
    // platform's native fetch (and therefore project egress) instead.
    (client as unknown as { axios: { defaults: { adapter: string } } }).axios.defaults.adapter =
      "fetch";
    return rpcCapabilityTree(client) as Record<string, unknown>;
  }

  async testFetch(input: { headerValue: string; url: string }): Promise<unknown> {
    const response = await fetch(input.url, {
      headers: { "x-itx-egress-proof": input.headerValue },
    });
    return await response.json();
  }
}

/**
 * Projects an SDK client into a shape Workers RPC can return from a getter:
 * plain objects are kept (recursively), functions become RPC stubs, everything
 * else — class instances like the SDK's HTTP client, config strings like the
 * token — is dropped. The Slack SDK builds its method families
 * (`chat.postMessage`, `conversations.history`, ...) as plain nested objects
 * of pre-bound functions, so the whole Web API survives this projection.
 */
function rpcCapabilityTree(value: object): unknown {
  const tree: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "function") {
      tree[key] = entry.bind(value);
    } else if (isPlainObject(entry)) {
      tree[key] = rpcCapabilityTree(entry);
    }
  }
  return tree;
}

function isPlainObject(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
