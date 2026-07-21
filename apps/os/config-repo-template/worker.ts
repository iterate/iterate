import {
  IterateWorkerEntrypoint,
  type StatefulDynamicWorkerRef,
  type StreamEvent,
} from "iterate/sdk";
import { guestbookAppRef } from "./apps/guestbook/ref.ts";
import {
  githubConnectionStreamPath,
  reviewBotSubscriptionEvents,
} from "./apps/review-bot/src/review-bot-ref.ts";

// An iterate project is, in the abstract, just a fetch function.
// HTTP clients on the internet can send us Requests, and we will send responses and
// occasionally send HTTP requests outwards to the world to take influence on it.
//
// Internally, different parts of a project communicate by appending and subscribing to append-only
// event streams.
//
// Hence, the essence of an iterate project can be expressed as two functions:
// { fetch, processEvent }

const repoFiles = { type: "repo", repoPath: "/repos/config" } as const;

/** LiveState + Cap'n Web todos in a SQLite Durable Object (`apps/todo`). */
export const todoAppRef = {
  className: "TodoApp",
  // "-live" keeps clear of a retired predecessor's durable identity.
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
    if (app === "todo") {
      using itx = await this.env.ITX.get();
      const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(req);
      if (authResponse) return authResponse;
      return this.fetchDynamicWorker(req, todoAppRef);
    }
    if (app === "guestbook") {
      return this.fetchDynamicWorker(req, guestbookAppRef);
    }
    if (app === "tasks") {
      // Member-gated reverse proxy (pages, assets, WebSockets) to the hosted
      // tasks board (github.com/iterate/tasks), which authenticates each
      // visitor back to os.iterate.com. The kv knob targets a dev tunnel
      // while developing the tasks app itself.
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
                <li><a href="${appUrl("todo")}">todo</a> (LiveState + Cap'n Web, project members only)</li>
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
