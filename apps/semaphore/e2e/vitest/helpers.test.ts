import { expect, test } from "vitest";
import { waitForHealth } from "../helpers.ts";

test("waits for matching public-worker and coordinator rollout proof", async () => {
  const responses = [
    Response.json(
      {
        ok: false,
        workerVersion: "new-worker-version",
        coordinatorVersion: "old-coordinator-version",
      },
      {
        status: 503,
        headers: { "x-iterate-worker-version": "new-worker-version" },
      },
    ),
    Response.json(
      {
        ok: true,
        workerVersion: "new-worker-version",
        coordinatorVersion: "new-worker-version",
      },
      {
        headers: { "x-iterate-worker-version": "new-worker-version" },
      },
    ),
  ];
  const requestedUrls: string[] = [];

  await waitForHealth({
    baseURL: "https://semaphore.iterate.test",
    timeoutMs: 1_000,
    networkFetch: async (input) => {
      requestedUrls.push(String(input));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra health request");
      return response;
    },
    now: () => 0,
    sleep: async () => {},
  });

  expect(requestedUrls).toEqual([
    "https://semaphore.iterate.test/health",
    "https://semaphore.iterate.test/health",
  ]);
});

test("rejects a successful response without matching rollout evidence", async () => {
  const responses = [
    Response.json(
      {
        ok: true,
        workerVersion: "new-worker-version",
        coordinatorVersion: "old-coordinator-version",
      },
      { headers: { "x-iterate-worker-version": "new-worker-version" } },
    ),
    Response.json(
      {
        ok: true,
        workerVersion: "new-worker-version",
        coordinatorVersion: "new-worker-version",
      },
      { headers: { "x-iterate-worker-version": "wrong-public-version" } },
    ),
  ];
  const times = [0, 0, 0, 2];

  await expect(
    waitForHealth({
      baseURL: "https://semaphore.iterate.test",
      timeoutMs: 1,
      networkFetch: async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected extra health request");
        return response;
      },
      now: () => {
        const time = times.shift();
        if (time === undefined) throw new Error("Unexpected extra clock read");
        return time;
      },
      sleep: async () => {},
    }),
  ).rejects.toThrow("Timed out waiting for health at https://semaphore.iterate.test");
});
