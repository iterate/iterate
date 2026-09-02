// load-persistent-stub.e2e.test.ts — Kenton's persistent-stub machinery IN USE: a userspace durable object
// stores its live capability handle (the ctx.exports-minted ItxEntrypoint stub) in
// its OWN storage, then uses the handle read back from storage — which replays the restore
// chain on use. storage.put would THROW for any non-restorable stub, so put succeeding + the
// restored call answering IS the proof the machinery accepted and replayed it.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("persistent stub: stash a live capability handle in DO storage, use the restored handle", async () => {
  const ctx = freshCtx("rest");
  const itx = openItx(ctx);
  await seedSources(itx, ["keeper"]);

  await itx.provide(
    "itx.keeper",
    `itx.load("itx.kv.get('src/keeper.js')").getDurableObjectClass('Keeper').get()`,
  );

  // 1. stash: storage.put(env.ITX) — throws unless the whole chain is restore-eligible
  const stashed = await itx.invokeCapability(["itx", "keeper", ["stash"]]);
  expect(stashed?.stashed).toBe(true); // storage.put accepted the live capability handle

  // 2. use the RESTORED handle (storage.get replays the restore chain on use)
  const who = await itx.invokeCapability(["itx", "keeper", ["useStashed"]]);
  expect(who?.projectId).toBe(ctx); // restored handle answers whoami through the routed table

  // 3. and again — replay is per-load, not a one-shot
  const who2 = await itx.invokeCapability(["itx", "keeper", ["useStashed"]]);
  expect(who2?.projectId).toBe(ctx); // second load replays again
});
