// config-worker-from-repo.e2e.test.ts — THE PAYOFF: the config worker's source moved OUT of KV and
// INTO a real Artifacts repo, with nothing else changed. The `itx.worker` rewrite is the seam — its
// `source` producer is now `itx.repos.readFile('config','worker.ts')` instead of `itx.kv.get(...)` —
// so the funnel delivers a subscribed event to a ConfigWorker whose bytes rode git-over-HTTPS. This is
// the same shape as config-worker.e2e (KV), swapping ONLY the source producer.
//
// DEPLOYED-TARGET ONLY (Artifacts has no local impl). Run with
// `WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e config-worker-from-repo`.

import { expect } from "vitest";
import { append, freshCtx, openItx, readAll, until } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

const PING = "repo-config-ping";
const PONG = "repo-config-pong";

// The config worker, exactly as in the KV proof — a ConfigWorker overriding processEvent, idempotent
// (the pong's key is the ping's offset). The only difference is WHERE these bytes live: a git repo.
const CONFIG_WORKER_SRC = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(PING)})
      await itx.builtins.append({
        type: ${JSON.stringify(PONG)},
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
      await itx.repos.writeFile("config", "worker.ts", CONFIG_WORKER_SRC);
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
        consumes: [PING],
      });

      // 4. A ping commits; the repo-sourced config worker's processEvent runs and appends a pong.
      const [ping] = await append(itx, { type: PING });
      await until(
        "the repo-sourced config worker appended a pong for the ping",
        async () =>
          (await readAll(itx)).some((e) => e.type === PONG && e.payload?.pinged === ping.offset),
        15_000,
      );
    } finally {
      await itx.cfArtifacts.delete("config"); // teardown — same repo cfArtifacts/repos address
    }
  },
);
