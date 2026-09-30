// vitest/os-workers/fresh-file.test.ts — what a Workers-suite file leaves in the runtime it shares
// with the next (vitest.config.ts `isolate: false`), and what the next one finds: nothing
// (empty-runtime.ts, which fresh-file.ts runs before every file). Each row stores through every kind
// of storage the suite binds, then empties the runtime mid-file as the next file's setup would.
import { applyD1Migrations, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, onTestFinished, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { emptyRuntime } from "./empty-runtime.ts";
import { stub } from "./support.ts";

test("a file finds nothing an earlier one stored: an evicted context, a loaded one and its alarm, D1, KV and the Cache API", async () => {
  migrateAfterwards();
  for (const ctx of ["prj_fresh_evicted", "prj_fresh_loaded"])
    await runInDurableObject(stub(ctx), (_instance, state) =>
      state.storage.kv.put("left-by", "the earlier file"),
    );
  await runInDurableObject(stub("prj_fresh_loaded"), (_instance, state) =>
    state.storage.setAlarm(Date.now() + 3_600_000),
  );
  await evictDurableObject(stub("prj_fresh_evicted"));
  await env.DB.prepare("CREATE TABLE left_by (file TEXT)").run();
  await env.ITX_KV.put("left-by", "the earlier file");
  const cache = await caches.open("left-by");
  await cache.put(
    "https://left-by.test/",
    new Response("the earlier file", { headers: { "cache-control": "max-age=3600" } }),
  );

  await emptyRuntime();

  expect(await env.DB.prepare("SELECT name FROM sqlite_master").all()).toMatchObject({
    results: [],
  });
  expect(await env.ITX_KV.get("left-by")).toBeNull();
  expect(await cache.match("https://left-by.test/")).toBeUndefined();
  // a context's birth reads the catalog: migrated, as the next file's setup does
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await leftIn("prj_fresh_evicted")).toBeUndefined();
  expect(await leftIn("prj_fresh_loaded")).toBeUndefined();
  expect(
    await runInDurableObject(stub("prj_fresh_loaded"), (_instance, state) =>
      state.storage.getAlarm(),
    ),
  ).toBeNull();
});

// THE GAP THE POOL'S DELETE FILLS (empty-runtime.ts step 3). The day `reset()` alone empties an
// evicted object, this row turns red, and the pool's delete (vitest.config.ts `TEST_STORAGE`) and
// patches/@cloudflare__vitest-plugin@1.3.2.patch can go.
createFailing(test, /an object evicted before reset\(\) should be empty after it/)(
  "reset() empties the storage of a context evicted before it",
  async () => {
    migrateAfterwards();
    await runInDurableObject(stub("prj_reset_evicted"), (_instance, state) =>
      state.storage.kv.put("left-by", "before the reset"),
    );
    await evictDurableObject(stub("prj_reset_evicted"));
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const left = await leftIn("prj_reset_evicted");
    await emptyRuntime();
    expect(left, "an object evicted before reset() should be empty after it").toBeUndefined();
  },
);

/** What a context left under `left-by`, read through the context's own storage. */
const leftIn = (ctx: string) =>
  runInDurableObject(stub(ctx), (_instance, state) => state.storage.kv.get("left-by"));

/** The rest of the file runs on a runtime a row emptied: D1 migrated again, as a file starts. */
const migrateAfterwards = () =>
  onTestFinished(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
