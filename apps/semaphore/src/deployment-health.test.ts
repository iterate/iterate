import { expect, test, vi } from "vitest";
import { semaphoreDeploymentHealth } from "./deployment-health.ts";

test("deployment health waits for a coordinator on the public Worker's exact version", async () => {
  const coordinatorVersion = vi.fn().mockResolvedValueOnce("previous-version");

  const response = await semaphoreDeploymentHealth({
    workerVersion: "new-version",
    coordinatorVersion,
  });

  expect(response).toMatchObject({ status: 503 });
  expect(await response.json()).toMatchObject({
    ok: false,
    workerVersion: "new-version",
    coordinatorVersion: "previous-version",
  });
  expect(response.headers.get("x-iterate-worker-version")).toBe("new-version");
});

test("deployment health becomes ready when the coordinator reaches the public Worker version", async () => {
  const response = await semaphoreDeploymentHealth({
    workerVersion: "new-version",
    coordinatorVersion: async () => "new-version",
  });

  expect(response).toMatchObject({ status: 200 });
  expect(await response.json()).toMatchObject({
    ok: true,
    workerVersion: "new-version",
    coordinatorVersion: "new-version",
  });
  expect(response.headers.get("x-iterate-worker-version")).toBe("new-version");
});

test("deployment health reports a bounded unavailable response while the coordinator resets", async () => {
  const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
    durableObjectReset: true,
  });

  const response = await semaphoreDeploymentHealth({
    workerVersion: "new-version",
    coordinatorVersion: vi.fn().mockRejectedValueOnce(reset),
  });

  expect(response).toMatchObject({ status: 503 });
  expect(await response.json()).toMatchObject({
    ok: false,
    workerVersion: "new-version",
    error: "Durable Object reset because its code was updated.",
  });
});
