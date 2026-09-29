// Config workers are explicit workers.get targets. Neither loading one nor creating a context
// subscribes it, configures ingress, or follows repository commits implicitly: only a project's own
// processor does, for its `/repos/config` (the last row). The repo a worker's source is read from is
// born through the collection (`itx.repos.create(path)`) and addressed as `itx.repos.get(path)`.
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, until } from "./support/client.ts";

test("a fresh context has no implicit worker subscription; an explicit cross-context target delivers", async () => {
  const root = openItx(freshCtx("config-explicit"));
  const child = root.cd("/child");
  expect(await child.subscriptions.list()).toEqual([]);
  await root.kv.put("config.js", source("kv"));
  await child.subscribe({
    name: "config",
    target: [
      "itx",
      ["cd", "/"],
      "workers",
      ["get", { source: "itx.kv.get('config.js')", cacheKey: "kv:v1" }],
      "processEventBatch",
    ],
    consumes: ["events.iterate.com/test/ping-sent"],
  });
  const [ping] = await child.append({ type: "events.iterate.com/test/ping-sent" });
  await until("the explicit worker answered on the root", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/pong-sent" && event.payload?.pinged === ping.offset,
    ),
  );
  expect(
    (await readAll(root)).find((event) => event.type === "events.iterate.com/test/pong-sent")
      ?.payload,
  ).toEqual({
    version: "kv",
    from: "/child",
    pinged: ping.offset,
  });
});

test("a repo-backed worker changes when its explicit subscription spec is updated", async () => {
  const root = openItx(freshCtx("config-revisions"));
  await root.repos.create("/repos/config");
  const repo = root.repos.get("/repos/config");
  const first = await repo.writeFile("worker.ts", source("v1"));
  const spec = {
    source: "itx.repos.get('/repos/config').readFile('worker.ts')",
    cacheKey: first.commitOid,
  };
  await root.subscribe({
    name: "config",
    target: ["itx", "workers", ["get", spec], "processEventBatch"],
    consumes: ["events.iterate.com/test/ping-sent", "events.iterate.com/repo/commit-completed"],
  });
  const [ping1] = await root.append({ type: "events.iterate.com/test/ping-sent" });
  await until("v1 answered", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/pong-sent" &&
        event.payload?.pinged === ping1.offset &&
        event.payload?.version === "v1",
    ),
  );
  const second = await repo.writeFile("worker.ts", source("v2"));
  // Even delivery of a commit fact does not mutate routing or subscriptions inside ConfigWorker.
  await root.append({
    type: "events.iterate.com/repo/commit-completed",
    payload: { commitOid: second.commitOid },
  });
  const [stillOld] = await root.append({ type: "events.iterate.com/test/ping-sent" });
  await until("the existing spec remains selected", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/pong-sent" &&
        event.payload?.pinged === stillOld.offset &&
        event.payload?.version === "v1",
    ),
  );
  await root.subscribe({
    name: "config",
    target: [
      "itx",
      "workers",
      ["get", { ...spec, cacheKey: second.commitOid }],
      "processEventBatch",
    ],
    consumes: ["events.iterate.com/test/ping-sent"],
  });
  const [ping2] = await root.append({ type: "events.iterate.com/test/ping-sent" });
  await until("v2 answered", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/pong-sent" &&
        event.payload?.pinged === ping2.offset &&
        event.payload?.version === "v2",
    ),
  );
});

test("a project's config worker runs one version: a commit moves its processEvent with its fetch", async () => {
  const root = openItx(freshCtx("config-follows-tip"));
  await root.repos.create("/repos/config");
  const repo = root.repos.get("/repos/config");
  const manifest = {
    events: ["events.iterate.com/test/ping-sent", "events.iterate.com/repo/commit-completed"],
  };
  // The config repo holds its first worker before the project is created, as a template's does:
  // the saga finds `main` born and publishes its tip.
  await repo.commitFiles({
    message: "v1",
    changes: [
      { path: "package.json", content: JSON.stringify({ main: "worker.ts" }) },
      { path: "iterate.json", content: JSON.stringify(manifest) },
      { path: "worker.ts", content: source("v1") },
    ],
  });
  await root.processors.enable("project");
  await root.append({
    type: "events.iterate.com/project/create-requested",
    payload: { slug: "config-follows-tip", orgId: "test" },
  });
  await root.waitForEvent({
    type: "events.iterate.com/project/created",
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  const pongFor = async (label: string) => {
    const [ping] = await root.append({ type: "events.iterate.com/test/ping-sent" });
    return await until(label, async () =>
      (await readAll(root)).find(
        (event) =>
          event.type === "events.iterate.com/test/pong-sent" &&
          event.payload?.pinged === ping.offset,
      ),
    );
  };
  expect((await pongFor("the first commit's processEvent")).payload).toMatchObject({
    version: "v1",
  });
  // The second commit changes only the worker: its publication is the ingress naming it.
  const second = await repo.commitFiles({
    message: "v2",
    changes: [{ path: "worker.ts", content: source("v2") }],
  });
  await until("the second commit published", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/itx/ingress-configured" &&
        event.payload?.target?.[2]?.[1]?.cacheKey === second.commitOid,
    ),
  );
  expect((await pongFor("the second commit's processEvent")).payload).toMatchObject({
    version: "v2",
  });
  // The second commit's worker is handed its own commit's fact (the first may be handed it too).
  await until("the second commit's worker saw its own commit", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/commit-seen" &&
        event.payload?.version === "v2" &&
        event.payload?.commitOid === second.commitOid,
    ),
  );
});

const source = (version: string) => `import { ConfigWorker } from "iterate/sdk";
export default class extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === "events.iterate.com/test/ping-sent") await itx.append({
      type: "events.iterate.com/test/pong-sent",
      payload: { version: ${JSON.stringify(version)}, from: event.path, pinged: event.offset },
      idempotencyKey: "pong:" + event.path + ":" + event.offset
    });
    if (event.type === "events.iterate.com/repo/commit-completed") await itx.append({
      type: "events.iterate.com/test/commit-seen",
      payload: { version: ${JSON.stringify(version)}, commitOid: event.payload.commitOid },
      idempotencyKey: "commit-seen:${version}:" + event.offset
    });
  }
}`;
