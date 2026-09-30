// A config entrypoint on a fan-out row gets one event per `deliverEvent` call, and a project's config
// worker moves with its commits. Birth rows are birth-rows.test's; the apex is website-publication's.
import { expect, test } from "vitest";
import { ITERATE_CAUSE_HEADER } from "iterate/lib";
import {
  adminCredentials,
  createdProject,
  freshCtx,
  openItx,
  publicationOf,
  readAll,
  session,
  until,
} from "../../helpers/client.ts";

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
  const pings = await child.append(PING, PING);
  const pongs = await Promise.all(pings.map((ping: { offset: number }) => pongFor(root, ping)));
  expect(pongs.map((pong) => pong.payload)).toEqual(
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
  const [ping1] = await root.append(PING);
  expect((await pongFor(root, ping1)).payload).toMatchObject({ version: "v1" });
  const second = await repo.writeFile("worker.ts", source("v2"));
  // Even delivery of a commit fact does not mutate routing or subscriptions inside the config entrypoint.
  await root.append({
    type: "events.iterate.com/repo/commit-completed",
    payload: { commitOid: second.commitOid },
  });
  const [stillOld] = await root.append(PING);
  expect((await pongFor(root, stillOld)).payload).toMatchObject({ version: "v1" });
  await root.subscribe({
    name: "pong",
    ordered: false,
    target: ["itx", "workers", ["get", { ...spec, cacheKey: second.commitOid }], "deliverEvent"],
    consumes: ["events.iterate.com/test/ping-sent"],
  });
  const [ping2] = await root.append(PING);
  expect((await pongFor(root, ping2)).payload).toMatchObject({ version: "v2" });
});

test("a config commit moves the worker's processEvent, and one made at depth 7 publishes at 7 and inits at 8", async () => {
  const ctx = freshCtx("config-follows-tip");
  const root = openItx(ctx);
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
  await createdProject(root, "config-follows-tip");
  const [first] = await root.append(PING);
  expect((await pongFor(root, first)).payload).toMatchObject({ version: "v1" });
  // our own code calling the platform back seven hand-offs into a chain (src/cause.ts) commits v2
  const chain = `a deep chain of ${ctx}`;
  const deep = session({ [ITERATE_CAUSE_HEADER]: JSON.stringify({ chain, depth: 7 }) })
    .authenticate(adminCredentials())
    .projects.get(ctx);
  const second = await deep.repos.get("/repos/config").commitFiles({
    message: "v2",
    changes: [{ path: "worker.ts", content: source("v2") }],
  });
  const published = await publicationOf(root, second.commitOid);
  expect(published.source.cause).toMatchObject({ chain, depth: 7 });
  const [next] = await root.append(PING);
  expect((await pongFor(root, next)).payload).toMatchObject({ version: "v2" });
  // v2's worker is handed its own publication, its init case, one hand-off deeper
  const initRan = await until("v2's worker saw its own publication", async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/publication-seen" &&
        event.payload?.version === "v2" &&
        event.payload?.commitOid === second.commitOid,
    ),
  );
  expect(initRan.source.cause).toMatchObject({ chain, depth: 8 });
});

const PING = { type: "events.iterate.com/test/ping-sent" };

/** The pong `root`'s config worker appended for `ping`. */
const pongFor = (root: any, ping: { offset: number }) =>
  until(`the pong for ${ping.offset}`, async () =>
    (await readAll(root)).find(
      (event) =>
        event.type === "events.iterate.com/test/pong-sent" && event.payload?.pinged === ping.offset,
    ),
  );

/** A config entrypoint: one pong on the root per ping, and which version saw each publication. */
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
