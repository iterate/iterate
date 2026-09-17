import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("health identifies the running OS worker without caching", async ({ request }, testInfo) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const health = await response.json();
  expect(health).toMatchObject({ ok: true, app: "os", version: expect.stringMatching(/\S/) });
  expect(response.headers()).toMatchObject({
    "cache-control": "no-store",
    "x-iterate-worker-version": health.version,
  });
  await testInfo.attach("running-worker", {
    body: JSON.stringify(health),
    contentType: "application/json",
  });
});
