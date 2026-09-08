// config-worker-funnel.e2e.test.ts — THE FUNNEL: every stream auto-subscribes the "/" context's
// config worker (the DO constructor appends the `config` subscription), so a CHILD context's events
// reach the root's config worker with NO manual wiring. Proves the apps/os project-worker shape end
// to end.

import { test } from "vitest";
import { append, freshCtx, openItx, readAll, until } from "./support/client.ts";

const PING = "events.iterate.com/funnel-ping";
const PONG = "events.iterate.com/funnel-pong";
const CONFIG_KEY = "/repos/config/worker.ts";

// A real config worker: on a ping (from ANY context — the funnel delivers every stream's events), it
// appends a pong to its OWN (root) context, naming the source path + offset. Idempotent.
const CONFIG_WORKER_SRC = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(PING)})
      await itx.builtins.append({
        type: ${JSON.stringify(PONG)},
        payload: { from: event.path, at: event.offset },
        idempotencyKey: "funnel-pong@" + event.path + "@" + event.offset,
      });
  }
}`;

test("funnel: a child context's event reaches the root config worker with no manual subscribe", async () => {
  const project = freshCtx("funnel");
  const root = openItx(project); // the "/" context

  // 1. Set up the project's ONE config worker at the root (source in KV + the itx.worker override).
  await root.kv.put(CONFIG_KEY, CONFIG_WORKER_SRC);
  await root.provide("itx.worker", [
    "itx",
    "workers",
    ["get", { source: `itx.kv.get('${CONFIG_KEY}')`, cacheKey: "funnel:v1" }],
  ]);

  // 2. A FRESH CHILD context (a path under the same project) — it auto-subscribes
  //    `itx.cd('/').worker.processEventBatch` in its constructor. No manual subscribe here.
  const child = root.cd("/child");

  // 3. The child appends a ping; the funnel carries it to the ROOT config worker, which appends a pong.
  const [ping] = await append(child, { type: PING });
  await until(
    "the root config worker processed the child's ping",
    async () =>
      (await readAll(root)).some(
        (e) =>
          e.type === PONG &&
          e.payload?.at === ping.offset &&
          String(e.payload?.from).endsWith("child"),
      ),
    20_000,
  );
});
