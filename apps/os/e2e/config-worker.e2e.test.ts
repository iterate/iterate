// Config workers are explicit workers.get targets. Neither loading one nor creating a context
// subscribes it, configures ingress, or follows repository commits implicitly. The repo a worker's
// source is read from is born through the collection (`itx.repos.create(path)`) and addressed as
// `itx.repos.get(path)`.
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

const source = (version: string) => `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === "events.iterate.com/test/ping-sent") await itx.append({
      type: "events.iterate.com/test/pong-sent",
      payload: { version: ${JSON.stringify(version)}, from: event.path, pinged: event.offset },
      idempotencyKey: "pong:" + event.path + ":" + event.offset
    });
  }
}`;
