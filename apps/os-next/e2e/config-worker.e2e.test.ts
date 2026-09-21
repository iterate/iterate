// Config workers are explicit workers.get targets. Neither loading one nor creating a context
// subscribes it, configures ingress, or follows repository commits implicitly.
import { expect, test } from "vitest";
import { append, freshCtx, openItx, readAll, until } from "./support/client.ts";
import { FakeArtifacts } from "./support/fake-artifacts.ts";
import { deployedOnly, localOnly } from "./support/project-host.ts";

const PING = "events.iterate.com/config-ping";
const PONG = "events.iterate.com/config-pong";
const source = (version: string) => `import { ConfigWorker } from "./processor.js";
export default class extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(PING)}) await itx.append({
      type: ${JSON.stringify(PONG)},
      payload: { version: ${JSON.stringify(version)}, from: event.path, pinged: event.offset },
      idempotencyKey: "pong:" + event.path + ":" + event.offset
    });
  }
}`;

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
    consumes: [PING],
  });
  const [ping] = await append(child, { type: PING });
  await until("the explicit worker answered on the root", async () =>
    (await readAll(root)).find(
      (event) => event.type === PONG && event.payload?.pinged === ping.offset,
    ),
  );
  expect((await readAll(root)).find((event) => event.type === PONG)?.payload).toEqual({
    version: "kv",
    from: "/child",
    pinged: ping.offset,
  });
});

localOnly(
  "a repo-backed worker changes when its explicit subscription spec is updated",
  async () => {
    const root = openItx(freshCtx("config-revisions"));
    const artifacts = await FakeArtifacts.start();
    try {
      await root.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
      const repo = root.repos.get("/repos/config");
      await repo.create();
      const first = await repo.writeFile("worker.ts", source("v1"));
      const spec = {
        source: "itx.repos.get('/repos/config').readFile('worker.ts')",
        cacheKey: first.commitOid,
      };
      await root.subscribe({
        name: "config",
        target: ["itx", "workers", ["get", spec], "processEventBatch"],
        consumes: [PING, "events.iterate.com/repo/commit-completed"],
      });
      const [ping1] = await append(root, { type: PING });
      await until("v1 answered", async () =>
        (await readAll(root)).find(
          (event) =>
            event.type === PONG &&
            event.payload?.pinged === ping1.offset &&
            event.payload?.version === "v1",
        ),
      );
      const second = await repo.writeFile("worker.ts", source("v2"));
      // Even delivery of a commit fact does not mutate routing or subscriptions inside ConfigWorker.
      await append(root, {
        type: "events.iterate.com/repo/commit-completed",
        payload: { commitOid: second.commitOid },
      });
      const [stillOld] = await append(root, { type: PING });
      await until("the existing spec remains selected", async () =>
        (await readAll(root)).find(
          (event) =>
            event.type === PONG &&
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
        consumes: [PING],
      });
      const [ping2] = await append(root, { type: PING });
      await until("v2 answered", async () =>
        (await readAll(root)).find(
          (event) =>
            event.type === PONG &&
            event.payload?.pinged === ping2.offset &&
            event.payload?.version === "v2",
        ),
      );
    } finally {
      await artifacts.close();
    }
  },
);

deployedOnly(
  "a real Artifacts repository supplies an explicit worker source expression",
  async () => {
    const root = openItx(freshCtx("config-artifacts"));
    const repo = root.repos.get("/repos/config");
    await repo.create();
    // The repository is REAL — one row in the account's Artifacts namespace. Deleted whatever
    // happens, like every other row that creates one (cfartifacts.e2e.test.ts), so the namespace the
    // paging proofs read stays the suite's own repos and not a landfill of past runs'.
    try {
      const { commitOid } = await repo.writeFile("worker.ts", source("artifacts"));
      await root.subscribe({
        name: "config",
        target: [
          "itx",
          "workers",
          [
            "get",
            { source: "itx.repos.get('/repos/config').readFile('worker.ts')", cacheKey: commitOid },
          ],
          "processEventBatch",
        ],
        consumes: [PING],
      });
      const [ping] = await append(root, { type: PING });
      await until("the repo-sourced worker answered", async () =>
        (await readAll(root)).find(
          (event) => event.type === PONG && event.payload?.pinged === ping.offset,
        ),
      );
    } finally {
      await root.cfArtifacts.delete("/repos/config");
    }
  },
);
