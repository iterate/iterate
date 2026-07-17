import { describe, expect, test } from "vitest";
import type { DynamicWorkerRef } from "./schemas.ts";
import {
  isWebSocketUpgradeRequest,
  takeWorkerFetchDispatch,
  WORKER_BUILDING_HEADER,
  WORKER_FETCH_DISPATCH_HEADER,
  withWorkerFetchDispatchHeader,
  workerBuildingResponse,
  workerBuildStatusResponse,
} from "./worker-fetch-dispatch.ts";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const ref: DynamicWorkerRef = {
  className: "SnakeApp",
  durableWorkerKey: "app-snake",
  path: "/",
  source: {
    files: { include: ["apps/snake/**"], repoPath: "/", type: "repo" },
    options: { entryPoint: "apps/snake/worker.ts" },
  },
  type: "stateful",
};

describe("worker fetch dispatch header", () => {
  test("round-trips a dispatch and strips the header from the inner request", () => {
    const request = withWorkerFetchDispatchHeader(
      new Request("https://snake.example.com/ws", { headers: { upgrade: "websocket" } }),
      { buildBudgetMs: 15_000, ref },
    );
    expect(request.headers.get(WORKER_FETCH_DISPATCH_HEADER)).not.toBeNull();

    const taken = takeWorkerFetchDispatch(request);
    expect(taken).not.toBeNull();
    expect(taken!.dispatch).toEqual({ buildBudgetMs: 15_000, ref });
    expect(taken!.request.headers.get(WORKER_FETCH_DISPATCH_HEADER)).toBeNull();
    // The rest of the request survives the copy.
    expect(taken!.request.url).toBe("https://snake.example.com/ws");
    expect(taken!.request.headers.get("upgrade")).toBe("websocket");
  });

  test("absent header answers null", () => {
    expect(takeWorkerFetchDispatch(new Request("https://snake.example.com/ws"))).toBeNull();
  });

  test("malformed header throws (internal callers compose it, so this is a bug)", () => {
    const headers = new Headers({ [WORKER_FETCH_DISPATCH_HEADER]: '{"nope":true}' });
    expect(() =>
      takeWorkerFetchDispatch(new Request("https://snake.example.com/ws", { headers })),
    ).toThrow();
  });

  test("building response is a marked, retryable, self-refreshing 503", async () => {
    const response = workerBuildingResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get(WORKER_BUILDING_HEADER)).toBe("1");
    expect(response.headers.get("retry-after")).not.toBeNull();
    // Platform chrome never gets the overlay injected on top.
    expect(response.headers.get("x-iterate-overlay")).toBe("1");
    const body = await response.text();
    // JS clients poll for the building marker to clear; no-JS clients fall
    // back to the meta refresh.
    expect(body).toContain(WORKER_BUILDING_HEADER);
    expect(body).toContain('<noscript><meta http-equiv="refresh"');
    expect(body).toContain('data-spinner="true"');
  });

  test("the classifier answers build-lifecycle errors with their pages, nothing else", async () => {
    // Errors arrive over RPC name-preserved, class identity lost — so the
    // classifier is exercised exactly the way real hops see them.
    const building = workerBuildStatusResponse(
      namedError("WorkerBuildInProgressError", "still building"),
    );
    expect(building).toMatchObject({ status: 503 });
    expect(
      workerBuildStatusResponse(namedError("RepoNotSeededError", "config repo is still seeding")),
    ).toMatchObject({ status: 503 });

    const failed = workerBuildStatusResponse(
      namedError("WorkerBuildFailedError", "Expected ; but found is"),
    );
    expect(failed).toMatchObject({ status: 500 });
    expect(await failed!.text()).toContain("Expected ; but found is");

    expect(workerBuildStatusResponse(new Error("anything else"))).toBeNull();
  });

  test("upgrade detection is header-cased", () => {
    const upgrade = new Request("https://snake.example.com/ws", {
      headers: { upgrade: "WebSocket" },
    });
    expect(isWebSocketUpgradeRequest(upgrade)).toBe(true);
    expect(isWebSocketUpgradeRequest(new Request("https://snake.example.com/"))).toBe(false);
  });
});
