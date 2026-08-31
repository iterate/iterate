// smoke.test.ts — the worker boots and answers /version, over plain HTTP (interface-level, so it
// holds against any runtime). Moved off the workerd-internal `SELF` lane onto the harness's real
// local worker as part of retiring the pool-workers lane down to its hibernation-only core.

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
});
afterAll(async () => {
  await harness?.stop();
});

test("worker answers /version", async () => {
  const res = await fetch(new URL("/version", harness.url));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("live-");
});
