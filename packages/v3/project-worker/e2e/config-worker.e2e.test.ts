// config-worker.e2e.test.ts — THE CONFIG WORKER convention, minimal and end to end:
//   • the worker's SOURCE lives at a KV key (`/repos/config/worker.ts`) — the repo stand-in;
//   • `itx.worker` is a REWRITE to "load the worker whose source is that KV entry"
//     (`itx.worker ⇒ itx.workers.get({ source: itx.kv.get('/repos/config/worker.ts'), cacheKey })`);
//   • the worker extends the SDK's `ConfigWorker` (bundled into processor.js) and overrides
//     `processEvent`; the platform calls `processEventBatch` at-least-once from a cursor it keeps;
//   • a subscription of `itx.worker.processEventBatch` is what every stream will get automatically.
//
// This proves the whole convention on ONE context. The "every stream subscribes the `/` context's
// worker" funnel (cross-context `itx.cd('/').worker.processEventBatch`, auto-subscribed in the DO
// constructor) builds on exactly this.

import { expect, test } from "vitest";
import { append, freshCtx, openItx, readAll, until } from "./support/client.ts";

const PING = "events.iterate.com/config-ping";
const PONG = "events.iterate.com/config-pong";
const CONFIG_KEY = "/repos/config/worker.ts";

// The config worker, as it lives in KV: a WorkerEntrypoint extending ConfigWorker, overriding
// processEvent. IDEMPOTENT — the pong's idempotencyKey is the ping's offset, so an at-least-once
// redelivery is a no-op (the subscribing context owns the cursor; this class owns no checkpoint).
const CONFIG_WORKER_SRC = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === ${JSON.stringify(PING)})
      await itx.builtins.append({
        type: ${JSON.stringify(PONG)},
        payload: { pinged: event.offset },
        idempotencyKey: "config-pong@" + event.offset,
      });
  }
}`;

test("the config worker: source in KV, itx.worker rewrite, processEvent runs on a subscribed event", async () => {
  const itx = openItx(freshCtx("configworker"));

  // 1. The source lives at a KV key — the repo stand-in (reproduced from a data structure).
  await itx.kv.put(CONFIG_KEY, CONFIG_WORKER_SRC);
  expect(await itx.kv.get(CONFIG_KEY)).toContain("ConfigWorker");

  // 2. itx.worker maps, via rewrite, to "load the worker whose source is that KV entry".
  await itx.provide("itx.worker", [
    "itx",
    "workers",
    ["get", { source: `itx.kv.get('${CONFIG_KEY}')`, cacheKey: "config:v1" }],
  ]);

  // 3. Subscribe its processEventBatch — the convention every stream will get automatically.
  await itx.subscribe({ name: "config", target: "itx.worker.processEventBatch", consumes: [PING] });

  // 4. A ping commits; the delivery calls the config worker's processEventBatch (cursor lane,
  //    at-least-once), its processEvent runs, and it appends a pong naming the ping's offset.
  const [ping] = await append(itx, { type: PING });
  await until(
    "the config worker appended a pong for the ping",
    async () =>
      (await readAll(itx)).some((e) => e.type === PONG && e.payload?.pinged === ping.offset),
    15_000,
  );
});
