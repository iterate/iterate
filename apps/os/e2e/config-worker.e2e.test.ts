// A config entrypoint subscribed by an explicit `workers.get` target with `ordered: false` (the
// fan-out kind) gets one event per `deliverEvent` call. Loading one neither configures ingress nor
// follows repository commits: only a project's own processor publishes its `/repos/config`, whose
// pointer `itx.config` both the apex and every birth row name (the last row). The repo a worker's
// source is read from is born through the collection (`itx.repos.create(path)`) and addressed as
// `itx.repos.get(path)`.
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, until } from "./support/client.ts";

test("a newborn context carries its birth subscription to the project's config entrypoint", async () => {
  const child = openItx(freshCtx("config-birth")).cd("/child");
  expect(await child.subscriptions.get("config")).toMatchObject({
    name: "config",
    target: "itx.cd('/').config.deliverEvent",
    ordered: false,
  });
});

test("an explicit cross-context fan-out target gets each event of a batch in its own call", async () => {
  const root = openItx(freshCtx("config-explicit"));
  const child = root.cd("/child");
  await root.kv.put("config.js", source("kv"));
  await child.subscribe({
    name: "pong",
    ordered: false,
    target: [
      "itx",
      ["cd", "/"],
      "workers",
      ["get", { source: "itx.kv.get('config.js')", cacheKey: "kv:v1" }],
      "deliverEvent",
    ],
    consumes: ["events.iterate.com/test/ping-sent"],
  });
  const pings = await child.append(
    { type: "events.iterate.com/test/ping-sent" },
    { type: "events.iterate.com/test/ping-sent" },
  );
  const pongs = () =>
    readAll(root).then((events) =>
      events.filter((event) => event.type === "events.iterate.com/test/pong-sent"),
    );
  await until(
    "the worker answered each ping on the root",
    async () => (await pongs()).length === 2,
  );
  expect((await pongs()).map((pong) => pong.payload).sort((a, b) => a.pinged - b.pinged)).toEqual(
    pings.map((ping: { offset: number }) => ({
      version: "kv",
      from: "/child",
      pinged: ping.offset,
    })),
  );
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
    name: "pong",
    ordered: false,
    target: ["itx", "workers", ["get", spec], "deliverEvent"],
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
  // Even delivery of a commit fact does not mutate routing or subscriptions inside the config entrypoint.
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
    name: "pong",
    ordered: false,
    target: ["itx", "workers", ["get", { ...spec, cacheKey: second.commitOid }], "deliverEvent"],
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
  // The config repo holds its first worker before the project is created, as a template's does:
  // the saga finds `main` born and its tip is the first publication.
  await repo.commitFiles({
    message: "v1",
    changes: [
      { path: "package.json", content: JSON.stringify({ main: "worker.ts" }) },
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
  // The second commit changes only the worker: its publication moves `itx.config`, which the apex
  // (fetch) and the root's birth row (processEvent) both name.
  const second = await repo.commitFiles({
    message: "v2",
    changes: [{ path: "worker.ts", content: source("v2") }],
  });
  await until("the second commit published", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/project/worker-updated" &&
        event.payload?.commitOid === second.commitOid,
    ),
  );
  expect((await pongFor("the second commit's processEvent")).payload).toMatchObject({
    version: "v2",
  });
  // The second commit's worker is handed its own publication: its init case.
  await until("the second commit's worker saw its own publication", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/publication-seen" &&
        event.payload?.version === "v2" &&
        event.payload?.commitOid === second.commitOid,
    ),
  );
});

/** A config entrypoint that answers each ping it is handed with one pong on the root, and says
 *  which version was handed each publication. An array (a batch) has no `type`, so it answers
 *  nothing. */
const source = (version: string) => `import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    if (event.type === "events.iterate.com/test/ping-sent") await itx.append({
      type: "events.iterate.com/test/pong-sent",
      payload: { version: ${JSON.stringify(version)}, from: event.path, pinged: event.offset },
      idempotencyKey: "pong:" + event.path + ":" + event.offset
    });
    if (event.type === "events.iterate.com/project/worker-updated") await itx.append({
      type: "events.iterate.com/test/publication-seen",
      payload: { version: ${JSON.stringify(version)}, commitOid: event.payload.commitOid },
      idempotencyKey: "publication-seen:${version}:" + event.offset
    });
  }
}`;
