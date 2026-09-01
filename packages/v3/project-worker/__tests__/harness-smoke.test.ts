// The harness's own proof: the REAL worker boots locally and answers like production.
import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

test("boot + whoami round trip through the capability table", async () => {
  const itx = await harness.itx("prj_harness_smoke");
  const who = await itx.invokeCapability(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: "prj_harness_smoke", path: "/" });
});

test("append + read through the real event log", async () => {
  const itx = await harness.itx("prj_harness_log");
  const [committed] = await itx.invokeCapability([
    "itx",
    ["append", { type: "mark", payload: { n: 1 } }],
  ]);
  expect(committed.offset).toBeGreaterThanOrEqual(1);
  const page = await itx.invokeCapability(["itx", ["read"]]);
  expect(page.events.some((e: any) => e.type === "mark")).toBe(true);
});
