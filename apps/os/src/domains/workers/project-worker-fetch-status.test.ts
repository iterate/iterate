import { describe, expect, test } from "vitest";
import { WORKER_BUILDING_HEADER } from "./worker-fetch-dispatch.ts";
import { projectWorkerFetchStatusResponse } from "./project-worker-fetch-status.ts";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("project worker fetch status", () => {
  test("models an unseeded config repo as bootstrap still in progress", () => {
    const response = projectWorkerFetchStatusResponse(
      namedError("RepoNotSeededError", "Repo has no commits yet"),
    );

    expect(response).toMatchObject({ status: 503 });
    expect(response?.headers.get(WORKER_BUILDING_HEADER)).toBe("1");
  });

  test("retains the ordinary worker build lifecycle responses", () => {
    expect(
      projectWorkerFetchStatusResponse(namedError("WorkerBuildInProgressError", "still building")),
    ).toMatchObject({ status: 503 });
    expect(
      projectWorkerFetchStatusResponse(namedError("WorkerBuildFailedError", "bad source")),
    ).toMatchObject({ status: 500 });
  });

  test("does not turn unrelated loader failures into polling pages", () => {
    expect(projectWorkerFetchStatusResponse(new Error("broken binding"))).toBeNull();
  });
});
