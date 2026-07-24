import { expect, test } from "vitest";
import type { StreamEvent } from "../sdk.ts";
import { GuestbookApp } from "./index.ts";

test("one packaged Guestbook handles HTTP and committed stream events", async () => {
  let dispatched: Request | undefined;
  const processed: StreamEvent[] = [];
  const workerResponse = new Response("worker response");
  const worker = {
    [Symbol.dispose]() {},
    async syncEvent(event: StreamEvent) {
      processed.push(event);
    },
  };
  const app = GuestbookApp.create({
    ITX: {
      async fetch(request: Request) {
        dispatched = request;
        return workerResponse;
      },
      async get() {
        return {
          [Symbol.dispose]() {},
          workers: { get: () => worker },
        };
      },
    },
  } as any);
  const request = new Request("https://guestbook--project.iterate.app/api", {
    body: "hello",
    headers: { upgrade: "websocket", "x-test": "preserved" },
    method: "POST",
  });
  const guestbookEvent = event({
    path: "/guestbook",
    type: "events.iterate.com/guestbook/entry-signed",
  });

  await expect(app.fetch(request)).resolves.toBe(workerResponse);
  await app.processEvent(event({ path: "/unrelated", type: "something/happened" }));
  await app.processEvent(guestbookEvent);

  expect(dispatched).toBeDefined();
  expect(dispatched).toMatchObject({
    method: "POST",
    url: "https://guestbook--project.iterate.app/api",
  });
  expect(dispatched?.headers.get("x-test")).toBe("preserved");
  expect(await dispatched?.text()).toBe("hello");
  expect(JSON.parse(dispatched?.headers.get("x-iterate-worker-dispatch") || "")).toMatchObject({
    ref: {
      className: "GuestbookApp",
      durableWorkerKey: "app-guestbook-stream",
      path: "/",
      source: {
        createWorker: {
          entryPoint: "node_modules/iterate/dist/guestbook/configured-worker.mjs",
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
  expect(processed).toEqual([guestbookEvent]);
});

function event(input: { path: string; type: string }): StreamEvent {
  return {
    createdAt: "2026-07-24T12:00:00.000Z",
    offset: 1,
    path: input.path,
    payload: {},
    type: input.type,
  };
}
