import { expect, test } from "vitest";
import { TodoApp } from "./index.ts";

test("a packaged Todo forwards HTTP to its private stateful worker", async () => {
  let dispatched: Request | undefined;
  const workerResponse = new Response("worker response");
  const app = TodoApp.create({
    ITX: {
      async fetch(request: Request) {
        dispatched = request;
        return workerResponse;
      },
    },
  } as any);
  const request = new Request("https://todo--project.iterate.app/api", {
    body: "hello",
    headers: { upgrade: "websocket", "x-test": "preserved" },
    method: "POST",
  });

  await expect(app.fetch(request)).resolves.toBe(workerResponse);

  expect(dispatched).toBeDefined();
  expect(dispatched).toMatchObject({
    method: "POST",
    url: "https://todo--project.iterate.app/api",
  });
  expect(dispatched?.headers.get("x-test")).toBe("preserved");
  expect(await dispatched?.text()).toBe("hello");

  const dispatch = JSON.parse(dispatched?.headers.get("x-iterate-worker-dispatch") || "");
  expect(dispatch).toMatchObject({
    ref: {
      className: "TodoApp",
      durableWorkerKey: "app-todo-live",
      path: "/",
      source: {
        createWorker: {
          entryPoint: "node_modules/iterate/dist/todo/configured-worker.mjs",
          files: {
            include: ["package.json"],
            repoPath: "/repos/config",
            type: "repo",
          },
        },
      },
      type: "stateful",
    },
  });
  expect(JSON.stringify(dispatch.ref)).not.toContain("apps/todo");
});
