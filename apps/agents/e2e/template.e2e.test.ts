import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, until } from "../../os/e2e/support/client.ts";

// Exercise the real config worker's lifecycle subscription using the local template tree.
// Downloading published GitHub trees is covered by the shared downloader tests.
test("the copied agents template installs its collection on project/created through public capabilities", async () => {
  const root = openItx(freshCtx("agents-template"));
  await expect(root.invoke("itx.agents.list()")).rejects.toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
  });
  await root.repos.create("/repos/config");
  const changes = await Promise.all(
    ["worker.ts", "agents.js", "iterate.json", "AGENTS.md"].map(async (path) => ({
      path,
      content: await readFile(
        new URL(`../../../configs/with-agents/${path}`, import.meta.url).pathname,
        "utf8",
      ),
    })),
  );
  await root.repos.get("/repos/config").commitFiles({ message: "Copy agents template", changes });
  await root.processors.enable("project");
  await root.append({
    type: "events.iterate.com/project/create-requested",
    payload: { slug: "agents-template", orgId: "test" },
  });
  await until("template installed agents", async () => {
    await root.invoke("itx.agents.list()");
    return true;
  }).catch(async (error) => {
    console.log(
      JSON.stringify({
        events: await readAll(root),
        subscriptions: await root.subscriptions.list(),
      }),
    );
    throw error;
  });
  await root.agents.create("/agents/first");
  expect(await root.agents.list()).toEqual([
    { path: "/agents/first", createdAt: expect.any(String) },
  ]);
  const events = await readAll(root);
  const subscription = events.find(
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      event.payload.name === "config-worker",
  );
  const created = events.find((event) => event.type === "events.iterate.com/project/created");
  expect(subscription.offset).toBeLessThan(created.offset);
  expect(events.filter((event) => /failed$/.test(event.type))).toEqual([]);
  expect(
    (await root.subscriptions.list()).filter((row: { halted?: unknown }) => row.halted),
  ).toEqual([]);
});
