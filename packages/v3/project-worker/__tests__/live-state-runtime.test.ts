// live-state-runtime.test.ts — REDUCED ⊕ RUNTIME live state, end to end over the EXTERNAL interface.
//
// This is an interface-level E2E (the apps/os shape): a real worker booted locally by the harness,
// reached ONLY over capnweb at /api — no workerd-internal test hooks — so the same test would pass
// against a live Cloudflare deployment or a self-hosted runtime. A userspace processor (Presence,
// loaded into a DYNAMIC WORKER via the Worker Loader) exposes live state combining:
//   • reduced state  — `ticks`, folded from durable 'tick' events (survives eviction, replayable), and
//   • runtime state  — `lastPokeMs`, a plain field the reduce never touches (reset on eviction),
//     bumped when a 'poke' EPHEMERAL event reaches its processEvent.
// A capnweb client subscribes, seeds through `liveSnapshot()`, and folds the deltas with the SHIPPABLE
// client store (src/client — the same store the browser hook uses). Both a reduced change and a
// runtime change sync through ONE projection and ONE revision chain, as ephemeral deltas.

import { afterAll, beforeAll, expect, test } from "vitest";
import { seedSources } from "../e2e/support/sources.ts";
import { connectLiveState } from "../src/client/live-state-client.ts";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
});
afterAll(async () => {
  await harness?.stop();
});

const until = async <T>(label: string, fn: () => T | undefined | false, timeoutMs = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

type PresenceLive = { ticks: number; lastPokeMs: number };

test("a dynamic-worker processor's live state combines reduced (ticks) + runtime (lastPokeMs); a client syncs both via ephemeral deltas", async () => {
  const itx = await harness.itx("prj_ls_runtime");
  await seedSources(itx, ["presence"]);
  await itx.enableProcessor("presence", {
    source: "itx.kv.get('src/presence.js')",
    className: "Presence",
  });

  const door = async (): Promise<{ rev: number; state: PresenceLive }> =>
    JSON.parse(
      JSON.stringify(await itx.invokeCapability("itx.facets.get('presence').liveSnapshot()")),
    );

  const { store } = await connectLiveState<PresenceLive>(itx, {
    key: "presence",
    name: "watch",
    door,
  });

  // Seed: reduced 0 ticks, runtime lastPokeMs 0 — the whole projection, read atomically through the door.
  expect(store.get()).toEqual({ ticks: 0, lastPokeMs: 0 });

  // REDUCED change: a durable 'tick' advances the fold → one delta syncs `ticks`; runtime untouched.
  await itx.invokeCapability("itx.stream.append({ type: 'tick' })");
  await until("ticks synced", () => store.get()?.ticks === 1);
  expect(store.get()!.lastPokeMs).toBe(0);

  // RUNTIME change: a 'poke' EPHEMERAL event bumps the runtime field in processEvent (no reduce) →
  // one out-of-band delta syncs `lastPokeMs`; the reduced field is preserved.
  await itx.invokeCapability("itx.stream.append({ type: 'poke', ephemeral: true })");
  await until("poke synced", () => (store.get()?.lastPokeMs ?? 0) > 0);
  expect(store.get()!.ticks).toBe(1);

  // Both fields ride ONE chain: the producer's door and the patched client doc agree byte-for-byte.
  const seed = await door();
  expect(store.get()).toEqual(seed.state);
  expect(store.rev()).toBe(seed.rev);

  // A second reduced change still chains from here (no re-seed needed after the runtime delta).
  const pokedAt = store.get()!.lastPokeMs;
  await itx.invokeCapability("itx.stream.append({ type: 'tick' })");
  await until("second tick synced", () => store.get()?.ticks === 2);
  expect(store.get()).toEqual({ ticks: 2, lastPokeMs: pokedAt });
});
