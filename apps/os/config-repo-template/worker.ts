import {
  IterateWorkerEntrypoint,
  type StatefulDynamicWorkerRef,
  type StreamEvent,
} from "iterate/sdk";
import {
  githubConnectionStreamPath,
  reviewBotSubscriptionEvents,
} from "./apps/review-bot/src/review-bot-ref.ts";

// An iterate project is, in the abstract, just a fetch function.
// HTTP clients on the internet can send us Requests, and we will send responses and
// occasionally send HTTP requests outwards to the world to take influence on it.
//
// Interally, different parts of a project communicate by appending and subscribing to append-only
// event streams.
//
// Hence, the essence of an iterate project can be expressed as two functions:
// { fetch, processEvent }

const repoFiles = { type: "repo", repoPath: "/repos/config" } as const;

/** Stateless hello JSON app (`apps/hello`). */
export const helloAppRef = {
  type: "stateless" as const,
  path: "/",
  entrypoint: "HelloApp",
  source: {
    createWorker: {
      entryPoint: "apps/hello/src/hello-app.ts",
      files: repoFiles,
      minify: true,
    },
  },
};

/** Project-member-only Cap'n Web + HTML app (`apps/internal`). */
export const internalAppRef = {
  type: "stateless" as const,
  path: "/",
  entrypoint: "InternalApp",
  source: {
    createWorker: {
      entryPoint: "apps/internal/src/internal-app.ts",
      files: repoFiles,
      minify: true,
    },
  },
};

/** LiveState + Cap'n Web todos in a SQLite Durable Object (`apps/todo`). */
export const todoAppRef = {
  className: "TodoApp",
  durableWorkerKey: "app-todo-live",
  path: "/",
  source: {
    createApp: {
      client: "apps/todo/client.tsx",
      files: repoFiles,
      server: "apps/todo/server.tsx",
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

/** Stateful counter Durable Object (`apps/counter`). */
export const counterAppRef = {
  type: "stateful" as const,
  path: "/",
  className: "CounterApp",
  durableWorkerKey: "app-counter",
  source: {
    createWorker: {
      entryPoint: "apps/counter/src/counter-app.ts",
      files: repoFiles,
      minify: true,
    },
  },
};

/** Stream-processor guestbook: reduce on /guestbook (`apps/guestbook`). */
export const guestbookAppRef = {
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook-stream",
  path: "/",
  source: {
    createApp: {
      client: "apps/guestbook/client.tsx",
      files: repoFiles,
      server: "apps/guestbook/server.tsx",
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

let guestbookInitialization: Promise<void> | undefined;

export default class ProjectWorker extends IterateWorkerEntrypoint {
  // The base class delivers committed events on ANY stream here at least once and in
  // per-stream order.
  protected override async processEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "events.iterate.com/repo/github-link-configured": {
        // The pull-request review bot (apps/review-bot) is a stream processor
        // on each GitHub connection's webhook stream. A repo link is the rare
        // moment a connection starts mattering to this project, and its fact
        // carries the connection slug — so this lane offers the bot's durable
        // WAKE subscription once per (re-)link, not once per webhook. The
        // append is idempotent, and a freshly configured wake subscription
        // replays its stream from offset zero, so pull requests opened
        // shortly before the link (within the bot's freshness horizon) still
        // get reviewed. From then on the stream spine dials the app
        // directly, without this worker in the loop.
        const connection = event.payload?.connection;
        if (typeof connection !== "string" || connection.length === 0) break;
        using itx = await this.env.ITX.get();
        await itx.streams
          .get(githubConnectionStreamPath(connection))
          .append(...reviewBotSubscriptionEvents(connection));
        break;
      }
      default:
        break;
    }
  }

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "hello") {
      return this.fetchDynamicWorker(req, helloAppRef);
    }
    if (app === "internal") {
      return this.fetchDynamicWorker(req, internalAppRef);
    }
    if (app === "todo") {
      using itx = await this.env.ITX.get();
      const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(req);
      if (authResponse) return authResponse;
      return this.fetchDynamicWorker(req, todoAppRef);
    }
    if (app === "counter") {
      return this.fetchDynamicWorker(req, counterAppRef);
    }
    if (app === "guestbook") {
      // The guestbook's domain history lives on the project stream at
      // /guestbook; its app hosts the processor behind a durable WAKE
      // subscription (apps/guestbook/server.tsx). Unlike the review bot —
      // whose bootstrap rides the repo-link fact in processEvent above —
      // nothing platform-side announces "someone wants a guestbook", so the
      // first visit appends the idempotent creation batch here.
      guestbookInitialization ??= (async () => {
        using itx = await this.env.ITX.get();
        await itx.streams.get("/guestbook").append(
          {
            type: "events.iterate.com/guestbook/created",
            payload: { config: { title: "Guestbook" } },
            idempotencyKey: "guestbook/created",
          },
          {
            type: "events.iterate.com/stream/subscription-configured",
            payload: {
              subscriptionKey: "app-guestbook#guestbook",
              delivery: {
                mode: "wake",
                expression: [
                  "workers",
                  ["get", guestbookAppRef],
                  "processor",
                  "wakeStreamSubscriber",
                ],
                processorSlug: "guestbook",
              },
            },
            idempotencyKey: "guestbook/subscription:v1",
          },
        );
      })().catch((error: unknown) => {
        // A failed setup must be retryable by the next request; successful
        // setup remains durable and needs no more stream RPCs in this isolate.
        guestbookInitialization = undefined;
        throw error;
      });
      await guestbookInitialization;
      return this.fetchDynamicWorker(req, guestbookAppRef);
    }
    if (app === "tasks") {
      // A collaborative Kanban board over this repo's tasks/ markdown
      // (github.com/iterate/tasks): project-member gate, then a transparent
      // reverse proxy — pages, assets, and WebSocket upgrades — to the
      // deployed vessel. The ingress already stamps x-itx-project-id and the
      // platform session cookie rides along, so the vessel authenticates
      // every connection back to os.iterate.com as the visiting user; no
      // secrets or state live in the vessel. The kv knob points the proxy at
      // a dev tunnel while developing the tasks app itself (see its README);
      // absent knob means the deployed vessel.
      using itx = await this.env.ITX.get();
      const denied = await itx.auth.get({ policy: "project-member" }).fetch(req);
      if (denied) return denied;
      const tasksUrl = new URL(req.url);
      tasksUrl.protocol = "https:";
      const origin = await itx.kv.get("tasks-app-origin");
      tasksUrl.host =
        typeof origin === "string" && origin !== "" ? origin : "tasks.iterate.workers.dev";
      return fetch(
        new Request(tasksUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: "manual",
        }),
      );
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });

    const url = new URL(req.url);
    const hostKind = req.headers.get("x-iterate-host-kind");
    const appUrl = (slug: string) =>
      `${url.protocol}//${hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`}/`;
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from your iterate project worker.</p>
              <ul>
                <li><a href="${appUrl("hello")}">hello</a> (stateless)</li>
                <li><a href="${appUrl("internal")}">internal</a> (project members only)</li>
                <li><a href="${appUrl("todo")}">todo</a> (LiveState + Cap'n Web, project members only)</li>
                <li><a href="${appUrl("counter")}">counter</a> (stateful)</li>
                <li><a href="${appUrl("guestbook")}">guestbook</a> (stream processor reduce on /guestbook, public)</li>
                <li><a href="${appUrl("tasks")}">tasks</a> (collaborative task board over tasks/, project members only)</li>
              </ul>
              <p>Edit worker.ts in the project repo to change this.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
