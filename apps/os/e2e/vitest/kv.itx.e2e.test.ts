import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// itx.kv: the small durable project key-value store (project-DO storage).
// Round-trip, delete, prefix listing, and per-project isolation — the knob
// store a config worker reads on its next request (docs/remote-apps.md uses
// it to flip a reverse-proxy target between prod and a dev tunnel).
test("itx.kv round-trips small values, lists by prefix, and is project-scoped", async () => {
  using session = withItxSession();
  using admin = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = admin.projects.create({ slug: `kv-${crypto.randomUUID().slice(0, 8)}` });
  await project.projectId;
  using other = admin.projects.create({ slug: `kv-other-${crypto.randomUUID().slice(0, 8)}` });

  expect(await project.kv.get("tasks-app-origin")).toBeNull();

  await project.kv.set("tasks-app-origin", "jonas-tasks.tunnels.iterate.com");
  expect(await project.kv.get("tasks-app-origin")).toBe("jonas-tasks.tunnels.iterate.com");

  // Values are structured, not just strings.
  await project.kv.set("routing/tasks", { canaryUserIds: ["usr_1"], target: "dev" });
  expect(await project.kv.get("routing/tasks")).toEqual({
    canaryUserIds: ["usr_1"],
    target: "dev",
  });

  expect((await project.kv.list()).sort()).toEqual(["routing/tasks", "tasks-app-origin"]);
  expect(await project.kv.list({ prefix: "routing/" })).toEqual(["routing/tasks"]);

  // Another project sees none of it.
  expect(await other.kv.get("tasks-app-origin")).toBeNull();
  expect(await other.kv.list()).toEqual([]);

  await project.kv.delete("tasks-app-origin");
  expect(await project.kv.get("tasks-app-origin")).toBeNull();
  // Deleting an absent key is a no-op, not an error.
  await project.kv.delete("tasks-app-origin");

  // Guards: empty keys and oversized values refuse. (Async closures: a bare
  // expect(stub).rejects can vacuously pass — see capnweb notes.)
  await expect(async () => {
    await project.kv.set("", "x");
  }).rejects.toThrow(/non-empty/);
  await expect(async () => {
    await project.kv.set("big", "x".repeat(70 * 1024));
  }).rejects.toThrow(/too large/);
});
