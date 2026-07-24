import { TasksApp } from "@iterate-com/tasks";
import { GithubAiLinter } from "iterate/starter-apps/github-ai-linter";
import { GuestbookApp } from "iterate/starter-apps/guestbook";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { TodoApp } from "iterate/starter-apps/todo";

// An iterate project is, in the abstract, just a fetch function.
// HTTP clients on the internet can send us Requests, and we will send responses and
// occasionally send HTTP requests outwards to the world to take influence on it.
//
// Internally, different parts of a project communicate by appending and subscribing to append-only
// event streams.
//
// Hence, the essence of an iterate project can be expressed as two functions:
// { fetch, processEvent }

export default class ProjectWorker extends IterateWorkerEntrypoint {
  #aiLintApp = GithubAiLinter.create(this.env, {
    policyVersion: "2",
    rules: {
      glob: "rules/**/*.md",
      repoPath: "/repos/config",
    },
  });
  #guestbookApp = GuestbookApp.create(this.env);
  #tasksApp = TasksApp.create(this.env, {
    auth: { policy: "project-member" },
    proxy: {
      origin: "https://tasks.iterate.workers.dev",
      originOverrideKvKey: "tasks-app-origin",
    },
  });
  #todoApp = TodoApp.create(this.env);

  // The base class delivers committed events on ANY stream here at least once and in
  // per-stream order.
  protected override async processEvent(event: StreamEvent): Promise<void> {
    await this.#aiLintApp.processEvent(event);
    await this.#guestbookApp.processEvent(event);
  }

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "todo") {
      using itx = await this.env.ITX.get();
      const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(req);
      if (authResponse) return authResponse;
      return this.#todoApp.fetch(req);
    }
    if (app === "guestbook") {
      return this.#guestbookApp.fetch(req);
    }
    if (app === "tasks") {
      return this.#tasksApp.fetch(req);
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
