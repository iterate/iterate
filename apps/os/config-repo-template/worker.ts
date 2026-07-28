import { GithubAiLinter } from "iterate/starter-apps/github-ai-linter";
import { GuestbookApp } from "iterate/starter-apps/guestbook";
import { IterateWorkerEntrypoint, type SchedulerRecurrence, type StreamEvent } from "iterate/sdk";
import { TodoApp } from "iterate/starter-apps/todo";

const HEARTBEAT_SCHEDULE_PREFIX = "iterate/config/heartbeat/";
const HEARTBEAT_SCRIPT = `async (itx, schedule, trigger) => {
  await itx.streams.get("/").append({
    type: "events.iterate.com/project/reconciliation-requested",
    idempotencyKey: "iterate/config/heartbeat:" + trigger.executionId,
    payload: { scheduleKey: schedule.key },
  });
}`;

// Project-owned configuration: use the scheduler's native recurrence shape.
// Add entries for multiple cadences, use `{ every: 1 }` in a fast test
// project, or set this to `[]` when the project needs no periodic heartbeat.
const heartbeatSchedules: Array<{ key: string; recurrence: SchedulerRecurrence }> = [
  {
    key: `${HEARTBEAT_SCHEDULE_PREFIX}every-15-minutes`,
    recurrence: { every: 15 * 60 },
  },
];

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
  #todoApp = TodoApp.create(this.env);

  // The base class delivers committed events on ANY stream here at least once and in
  // per-stream order.
  protected override async processEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.path !== "/") break;
        // Put literal, once-per-creation subscription configuration and
        // initial appends here. Returning from this case is the platform's
        // project/created barrier.
        await this.reconcileProject();
        break;
      }
      case "events.iterate.com/project/reconciliation-requested": {
        if (event.path !== "/") break;
        console.log("Project heartbeat fired", { scheduleKey: event.payload?.scheduleKey });
        await this.reconcileProject();
        break;
      }
      case "events.iterate.com/stream/woken": {
        if (event.path !== "/") break;
        await this.reconcileProject();
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        const origin = event.source?.crossPostedFrom?.at(-1);
        if (
          event.path !== "/" ||
          origin?.path !== "/repos/config" ||
          origin.projectId === null ||
          origin.subscriptionKey !== "cross-post:/" ||
          origin.type !== event.type
        ) {
          break;
        }
        await this.reconcileProject();
        break;
      }
      default:
        break;
    }

    await this.#aiLintApp.processEvent(event);
    await this.#guestbookApp.processEvent(event);
  }

  private async reconcileProject(): Promise<void> {
    using itx = await this.env.ITX.get();
    const configured = await itx.scheduler.list();
    const desiredKeys = new Set(heartbeatSchedules.map((schedule) => schedule.key));
    const operations: Promise<unknown>[] = heartbeatSchedules.map((schedule) =>
      itx.scheduler.ensure({ ...schedule, script: HEARTBEAT_SCRIPT }),
    );
    for (const schedule of configured) {
      if (schedule.key.startsWith(HEARTBEAT_SCHEDULE_PREFIX) && !desiredKeys.has(schedule.key)) {
        operations.push(itx.scheduler.cancel(schedule.key));
      }
    }
    await Promise.all(operations);
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
