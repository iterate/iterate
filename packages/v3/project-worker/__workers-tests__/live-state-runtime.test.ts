// live-state-runtime.test.ts — REDUCED ⊕ RUNTIME live state, end to end, inside workerd (the
// pool-workers lane, which — unlike the createTestHarness lane — runs with the Worker Loader's
// experimental flag, so a userspace processor FACET actually materializes here).
//
// The Presence processor (proof_sources.mjs, loaded into a DYNAMIC WORKER) exposes live state that
// COMBINES:
//   • reduced state  — `ticks`, folded from durable 'tick' events (survives eviction, replayable), and
//   • runtime state  — `lastPokeMs`, a plain field the reduce never touches (reset on eviction),
//     bumped when a 'poke' EPHEMERAL event reaches processEvent.
//
// A real capnweb client (dialing `/api` over a WebSocket on SELF, exactly like production) subscribes
// to the processor's live state, seeds through its `liveSnapshot()` door, and folds the deltas with
// the SHIPPABLE client store (src/client). Both a reduced change and a runtime change sync through
// ONE projection and ONE revision chain, as ephemeral LIVE_STATE_CHANGED deltas.

import { SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, expect, test } from "vitest";
import { connectLiveState } from "../src/client/live-state-client.ts";
import { seedSources } from "../proofs/proof_sources.mjs";

const CTX = "prj_ls_runtime";
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
const sessions: unknown[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openItx(): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api?ctx=${CTX}`, {
    headers: { Upgrade: "websocket" },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket) as any;
  sessions.push(session);
  return session.authenticate().get();
}

afterAll(() => {
  for (const s of sessions)
    try {
      if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
    } catch {
      /* already broken */
    }
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
  const itx = await openItx();
  await seedSources(itx, ["presence"]);
  await itx.enableProcessor("presence", {
    source: "itx.kv.get('src/presence.js')",
    className: "Presence",
  });

  const door = async (): Promise<{ rev: number; state: PresenceLive }> =>
    JSON.parse(
      JSON.stringify(await itx.invokeCapability("itx.facets.get('presence').liveSnapshot()")),
    );

  const store = await connectLiveState<PresenceLive>(itx, { key: "presence", name: "watch", door });

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
