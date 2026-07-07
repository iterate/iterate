import { describe, expect, test } from "vitest";
import type { DynamicWorkerRef } from "../../types.ts";
import {
  isWebSocketUpgradeRequest,
  takeWorkerFetchDispatch,
  WORKER_FETCH_DISPATCH_HEADER,
  withWorkerFetchDispatchHeader,
} from "./worker-fetch-dispatch.ts";

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

  test("upgrade detection is header-cased", () => {
    const upgrade = new Request("https://snake.example.com/ws", {
      headers: { upgrade: "WebSocket" },
    });
    expect(isWebSocketUpgradeRequest(upgrade)).toBe(true);
    expect(isWebSocketUpgradeRequest(new Request("https://snake.example.com/"))).toBe(false);
  });
});
