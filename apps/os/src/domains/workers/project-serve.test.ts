import { expect, test } from "vitest";
import { serveProjectResponse } from "./project-serve.ts";
import { workerBuildingResponse } from "./worker-fetch-dispatch.ts";
import { WORKER_SERVE_ERROR_HEADER } from "./worker-serve-info.ts";

// The overlay's HTMLRewriter injection is workerd-only and e2e-proven
// (worker-build-overlay.e2e.test.ts); these responses all pass the overlay
// untouched, so the envelope's classification runs under node.

const failOnError = (error: unknown) => {
  throw new Error(`onError must not fire here: ${String(error)}`);
};

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

test("a healthy response passes through with no outcome", async () => {
  const upstream = new Response("{}", { headers: { "content-type": "application/json" } });
  const served = await serveProjectResponse({
    fetchWorker: async () => upstream,
    onError: failOnError,
    request: new Request("https://app.example.com/api"),
  });
  expect(served.outcome).toBeNull();
  expect(served.response).toBe(upstream);
});

test("document navigations get the short cold-build race, other requests the long one", async () => {
  const budgets: (number | undefined)[] = [];
  const serve = (headers: Record<string, string>) =>
    serveProjectResponse({
      fetchWorker: async (buildBudgetMs) => {
        budgets.push(buildBudgetMs);
        return new Response("ok");
      },
      onError: failOnError,
      request: new Request("https://app.example.com/", { headers }),
    });
  await serve({ "sec-fetch-dest": "document" });
  await serve({ "sec-fetch-dest": "empty" });
  expect(budgets).toEqual([1_500, 15_000]);
});

test("a building page bubbling back from an inner hop reads as worker_building", async () => {
  const served = await serveProjectResponse({
    fetchWorker: async () => workerBuildingResponse(),
    onError: failOnError,
    request: new Request("https://app.example.com/"),
  });
  expect(served.outcome).toBe("worker_building");
  expect(served.response.status).toBe(503);
});

test("a budget-expired cold build answers the building page", async () => {
  const served = await serveProjectResponse({
    fetchWorker: async () => {
      throw namedError("WorkerBuildInProgressError", "still building");
    },
    onError: failOnError,
    request: new Request("https://app.example.com/"),
  });
  expect(served.outcome).toBe("worker_building");
  expect(served.response.status).toBe(503);
});

test("an unclassified failure answers the branded retrying page, error to onError only", async () => {
  const reported: unknown[] = [];
  const served = await serveProjectResponse({
    fetchWorker: async () => {
      throw new Error("KV namespace exploded");
    },
    onError: (error) => reported.push(error),
    request: new Request("https://app.example.com/"),
  });
  expect(served.outcome).toBe("worker_serve_error");
  expect(served.response.status).toBe(500);
  expect(served.response.headers.get(WORKER_SERVE_ERROR_HEADER)).toBe("1");
  expect(reported).toHaveLength(1);
  expect(await served.response.text()).not.toContain("KV namespace exploded");
});
