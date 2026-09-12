// config-worker.e2e.test.ts — THE CONFIG WORKER convention, end to end: a worker whose SOURCE the
// `itx.worker` rewrite produces (`itx.workers.get({ source: <producer>, cacheKey })`), extending the
// SDK's `ConfigWorker` (bundled into processor.js) and overriding `processEvent`; the platform calls
// its `processEventBatch` at-least-once from a cursor the SUBSCRIBING context keeps (the class owns no
// checkpoint, so each fixture's pong is idempotent on the ping's offset). Pins:
//   • source in KV (`/repos/config/worker.ts`), `itx.worker` rewritten onto it, a subscription of
//     `itx.worker.processEventBatch` — a ping commits, the worker's processEvent appends a pong
//   • THE FUNNEL: every stream auto-subscribes the "/" context's worker (the DO constructor appends the
//     `config` row), so a CHILD context's ping reaches the ROOT's config worker with no manual wiring
//   • DEPLOYED ONLY: the same worker with its source in a real Artifacts repo — the rewrite's producer
//     is `itx.repos.readFile('config','worker.ts')` and nothing else changes (Artifacts has no local
//     implementation; `WORKER_BASE_URL=https://os.iterate2.com pnpm e2e config-worker`)

import { expect, test } from "vitest";
import { append, freshCtx, openItx, readAll, until } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

// ── source in KV, on ONE context ──

const KV_PING = "events.iterate.com/config-ping";
const KV_PONG = "events.iterate.com/config-pong";
const CONFIG_KEY = "/repos/config/worker.ts";

// The config worker, as it lives in KV: a WorkerEntrypoint extending ConfigWorker, overriding
// processEvent. IDEMPOTENT — the pong's idempotencyKey is the ping's offset, so an at-least-once
// redelivery is a no-op (the subscribing context owns the cursor; this class owns no checkpoint).
const KV_CONFIG_WORKER_SOURCE = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(KV_PING)})
      await itx.builtins.append({
        type: ${JSON.stringify(KV_PONG)},
        payload: { pinged: event.offset },
        idempotencyKey: "config-pong@" + event.offset,
      });
  }
}`;

test("the config worker: source in KV, itx.worker rewrite, processEvent runs on a subscribed event", async () => {
  const itx = openItx(freshCtx("configworker"));

  // 1. The source lives at a KV key — the repo stand-in (reproduced from a data structure).
  await itx.kv.put(CONFIG_KEY, KV_CONFIG_WORKER_SOURCE);
  expect(await itx.kv.get(CONFIG_KEY)).toContain("ConfigWorker");

  // 2. itx.worker maps, via rewrite, to "load the worker whose source is that KV entry".
  await itx.provide("itx.worker", [
    "itx",
    "workers",
    ["get", { source: `itx.kv.get('${CONFIG_KEY}')`, cacheKey: "config:v1" }],
  ]);

  // 3. Subscribe its processEventBatch — the convention every stream will get automatically.
  await itx.subscribe({
    name: "config",
    target: "itx.worker.processEventBatch",
    consumes: [KV_PING],
  });

  // 4. A ping commits; the delivery calls the config worker's processEventBatch (cursor lane,
  //    at-least-once), its processEvent runs, and it appends a pong naming the ping's offset.
  const [ping] = await append(itx, { type: KV_PING });
  await until(
    "the config worker appended a pong for the ping",
    async () =>
      (await readAll(itx)).some((e) => e.type === KV_PONG && e.payload?.pinged === ping.offset),
    15_000,
  );
});

// ── THE FUNNEL: a child context's events reach the root's config worker ──

const FUNNEL_PING = "events.iterate.com/funnel-ping";
const FUNNEL_PONG = "events.iterate.com/funnel-pong";

// A real config worker: on a ping (from ANY context — the funnel delivers every stream's events), it
// appends a pong to its OWN (root) context, naming the source path + offset. Idempotent.
const FUNNEL_CONFIG_WORKER_SOURCE = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(FUNNEL_PING)})
      await itx.builtins.append({
        type: ${JSON.stringify(FUNNEL_PONG)},
        payload: { from: event.path, at: event.offset },
        idempotencyKey: "funnel-pong@" + event.path + "@" + event.offset,
      });
  }
}`;

test("funnel: a child context's event reaches the root config worker with no manual subscribe", async () => {
  const project = freshCtx("funnel");
  const root = openItx(project); // the "/" context

  // 1. Set up the project's ONE config worker at the root (source in KV + the itx.worker override).
  await root.kv.put(CONFIG_KEY, FUNNEL_CONFIG_WORKER_SOURCE);
  await root.provide("itx.worker", [
    "itx",
    "workers",
    ["get", { source: `itx.kv.get('${CONFIG_KEY}')`, cacheKey: "funnel:v1" }],
  ]);

  // 2. A FRESH CHILD context (a path under the same project) — it auto-subscribes
  //    `itx.cd('/').worker.processEventBatch` in its constructor. No manual subscribe here.
  const child = root.cd("/child");

  // 3. The child appends a ping; the funnel carries it to the ROOT config worker, which appends a pong.
  const [ping] = await append(child, { type: FUNNEL_PING });
  await until(
    "the root config worker processed the child's ping",
    async () =>
      (await readAll(root)).some(
        (e) =>
          e.type === FUNNEL_PONG &&
          e.payload?.at === ping.offset &&
          String(e.payload?.from).endsWith("child"),
      ),
    20_000,
  );
});

// ── THE PAYOFF (deployed only): the source in a real Artifacts repo, the rewrite's producer swapped ──

const REPO_PING = "repo-config-ping";
const REPO_PONG = "repo-config-pong";

// The config worker, exactly as in the KV proof — a ConfigWorker overriding processEvent, idempotent
// (the pong's key is the ping's offset). The only difference is WHERE these bytes live: a git repo.
const REPO_CONFIG_WORKER_SOURCE = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(REPO_PING)})
      await itx.builtins.append({
        type: ${JSON.stringify(REPO_PONG)},
        payload: { pinged: event.offset },
        idempotencyKey: "repo-config-pong@" + event.offset,
      });
  }
}`;

deployedOnly(
  "config worker: source in a REPO (not KV), loaded via itx.worker → itx.repos.readFile",
  async () => {
    const itx = openItx(freshCtx("cfgrepo"));

    try {
      // 1. The source lives in a real git repo — writeFile creates it and commits worker.ts on main.
      await itx.repos.writeFile("config", "worker.ts", REPO_CONFIG_WORKER_SOURCE);
      expect(await itx.repos.readFile("config", "worker.ts")).toContain("ConfigWorker");

      // 2. itx.worker maps, via rewrite, to "load the worker whose source is that REPO file" — the one
      //    line that differs from the KV proof (source: itx.repos.readFile instead of itx.kv.get).
      await itx.provide("itx.worker", [
        "itx",
        "workers",
        ["get", { source: `itx.repos.readFile('config','worker.ts')`, cacheKey: "config:repo:v1" }],
      ]);

      // 3. Subscribe its processEventBatch (the convention every stream gets automatically).
      await itx.subscribe({
        name: "config",
        target: "itx.worker.processEventBatch",
        consumes: [REPO_PING],
      });

      // 4. A ping commits; the repo-sourced config worker's processEvent runs and appends a pong.
      const [ping] = await append(itx, { type: REPO_PING });
      await until(
        "the repo-sourced config worker appended a pong for the ping",
        async () =>
          (await readAll(itx)).some(
            (e) => e.type === REPO_PONG && e.payload?.pinged === ping.offset,
          ),
        15_000,
      );
    } finally {
      await itx.cfArtifacts.delete("config"); // teardown — same repo cfArtifacts/repos address
    }
  },
);
