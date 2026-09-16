import { expect, test, vi } from "vitest";
import { PreviewTestRuns } from "./preview-test-runs.ts";

test("retiring a run stops its projects without deleting their data or stopping another run", async () => {
  const runs = new PreviewTestRuns(memoryStore());
  const first = { id: "2659/123/1", expiresAt: Date.now() + 60_000 };
  await runs.begin(first);
  await runs.registerProject("prj_generated_uuid", first);
  expect(await runs.isProjectRetired("prj_generated_uuid")).toBe(false);

  await runs.begin({ id: "2659/124/1", expiresAt: Date.now() + 60_000 });
  await runs.registerProject("prj_another_uuid", {
    id: "2659/124/1",
    expiresAt: Date.now() + 60_000,
  });
  await runs.retire(first.id); // An old finalizer arrives after the next run.

  expect(await runs.isProjectRetired("prj_generated_uuid")).toBe(true);
  expect(await runs.isProjectRetired("prj_another_uuid")).toBe(false);
  expect(await runs.isProjectRetired("prj_human_project")).toBe(false);
});

test("a cancelled run expires even if no finalizer or next run arrives", async () => {
  vi.useFakeTimers();
  try {
    const runs = new PreviewTestRuns(memoryStore());
    const expiresAt = Date.now() + 3_600_000;
    await runs.begin({ id: "123/2", expiresAt });
    await runs.registerProject("prj_cancelled", { id: "123/2", expiresAt });
    vi.setSystemTime(expiresAt);
    expect(await runs.isProjectRetired("prj_cancelled")).toBe(true);
    expect(await runs.isProjectRetired("prj_human_project")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("projects cannot change owners and retired attempts cannot be restarted", async () => {
  const runs = new PreviewTestRuns(memoryStore());
  const first = { id: "123/1", expiresAt: Date.now() + 60_000 };
  await runs.begin(first);
  await runs.registerProject("prj_generated_uuid", first);
  await runs.begin({ ...first, id: "123/2" });
  await expect(
    runs.registerProject("prj_generated_uuid", { ...first, id: "123/2" }),
  ).rejects.toThrow("cannot move");
  await expect(runs.begin(first)).rejects.toThrow("cannot be restarted");
});

test("environment reuse requires the current protocol and the same owner", async () => {
  const runs = new PreviewTestRuns(memoryStore());
  expect(await runs.canReuseEnvironment("pr-2659")).toBe(false);
  await runs.markEnvironmentReusable("pr-2659");
  expect(await runs.canReuseEnvironment("pr-2659")).toBe(true);
  expect(await runs.canReuseEnvironment("pr-2660")).toBe(false);
});

function memoryStore() {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) || null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
}
