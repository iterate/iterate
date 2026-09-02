// live-state-chains-client-side.e2e.test.ts — LIVE STATE, client-chained: each change event says
// "I am the diff relative to rev X"; the stream keeps NO per-key state — a delta is an ordinary
// ephemeral event like any other. Live state is not a subscription MODE: a client subscribes to the
// one event type (`consumes: ["events.iterate.com/live-state/changed"]`), receives every key's deltas
// in ordinary event batches, and keeps its key (`deltasFor`). The client does: subscribe → read the
// producer's door {rev, state} → apply payloads whose `from` matches its rev, re-read the door on any
// mismatch. Proves: the client loop converges byte-identical with the door, the steady path needs
// zero re-reads, revisions chain exactly (mini-app AND processor flavors), out-of-order/duplicate
// frames are harmless, the change events are unconsumable, REDUCED ⊕ RUNTIME state rides ONE
// projection through the shippable client store (src/client), and a malformed delta is the
// subscriber's to skip — never a rejected append.

import { expect, test } from "vitest";
import { connectLiveState } from "../src/client/live-state-client.ts";
import { append, freshCtx, openItx, until } from "./support/client.ts";
import { deltasFor, LIVE_STATE_CHANGED, liveClient } from "./support/live-client.ts";
import { seedSources } from "./support/sources.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test("live state chains client-side from the door — mini-app + processor flavors", async () => {
  const itx = openItx(freshCtx("live"));
  await seedSources(itx, ["chatroom", "chunky"]);

  // ── mini-app flavor: the chatroom (SDK LiveState helper), behind the rewrite rule itx.chat ──
  await itx.provide(
    "itx.chat",
    `itx.facets.get('chatroom', { source: "itx.kv.get('src/chatroom.js')", className: 'ChatroomDurableObject' })`,
  );

  const chat = liveClient(async () => clone(await itx.invoke("itx.chat.state()")));
  await itx.subscribe({
    name: "chatwatch",
    target: deltasFor(chat, "chat"),
    consumes: [LIVE_STATE_CHANGED],
  });
  await chat.seed();
  const chatSeedRev = chat.rev!; // an incarnation EPOCH, not 0 — reborn holders never re-use old revs
  expect(typeof chatSeedRev).toBe("number");
  expect((chat.doc as { messages: unknown[] }).messages.length).toBe(0);

  await itx.invoke(["itx", "chat", ["post", "jonas", "hi"]]);
  await itx.invoke(["itx", "chat", ["post", "jonas", "again"]]);
  await until("two messages", () => (chat.doc as { messages?: unknown[] })?.messages?.length === 2);
  // steady path: two patches applied, ZERO re-reads; client rev chained epoch→+1→+2
  expect(chat.applied).toBe(2);
  expect(chat.reseeds).toBe(0);
  expect(chat.rev).toBe(chatSeedRev + 2);
  expect((chat.doc as { messages: { text: string }[] }).messages[1].text).toBe("again");

  const door = clone(await itx.invoke("itx.chat.state()")) as {
    rev: number;
    state: unknown;
  };
  // door and patched client doc are byte-identical
  expect(door.rev).toBe(chat.rev);
  expect(JSON.stringify(door.state)).toBe(JSON.stringify(chat.doc));

  // out-of-order / duplicate frames are harmless: replay an old payload, then a gapped one
  chat.consume(clone(chat.frames.find((f) => f.from !== undefined)!)); // replay a real old frame
  await until("dup dropped", () => chat.dropped >= 1);
  expect((chat.doc as { messages: unknown[] }).messages.length).toBe(2);

  chat.consume({ key: "chat", from: chat.rev! + 5, to: chat.rev! + 6, patch: [] });
  await until("gap healed", () => chat.reseeds >= 1);
  // a gapped frame triggers one door re-read and converges
  expect(JSON.stringify(chat.doc)).toBe(JSON.stringify(door.state));
  expect(chat.rev).toBe(chatSeedRev + 2);

  // ── processor flavor: chunky's reduce, door = liveSnapshot() ──
  await itx.enableProcessor("chunky", {
    source: "itx.kv.get('src/chunky.js')",
    className: "ChunkyDurableObject",
  });
  const proc = liveClient(async () =>
    clone(await itx.invoke("itx.facets.get('chunky').liveSnapshot()")),
  );
  await itx.subscribe({
    name: "chunkywatch",
    target: deltasFor(proc, "chunky"),
    consumes: [LIVE_STATE_CHANGED],
  });
  await proc.seed();
  const seedRev = proc.rev!;
  expect(typeof seedRev).toBe("number");
  expect((proc.doc as { marks: number }).marks).toBe(0);

  await itx.invoke(`itx.append({ type: 'mark' })`);
  await until("mark reduced", () => ((proc.doc as { marks?: number })?.marks ?? 0) >= 1);
  await itx.invoke(`itx.append({ type: 'mark' })`);
  await until("second mark", () => ((proc.doc as { marks?: number })?.marks ?? 0) >= 2);
  // processor patches chained from the seed rev, zero re-reads; the doc matches the projection
  expect(proc.applied).toBe(2);
  expect(proc.reseeds).toBe(0);
  expect((proc.doc as { marks: number; chunks: number }).marks).toBe(2);
  expect((proc.doc as { marks: number; chunks: number }).chunks).toBe(0);

  // ── the loop guard: nothing consumed the change events ──
  const snap = await itx.invoke("itx.facets.get('chunky').snapshot()");
  expect(JSON.stringify(snap).includes("live-state")).toBe(false);
});

type PresenceLive = { ticks: number; lastPokeMs: number };

test("a dynamic-worker processor's live state combines reduced (ticks) + runtime (lastPokeMs); a client syncs both via ephemeral deltas", async () => {
  // PresenceProcessor (e2e/support/sources.ts) exposes live state combining REDUCED state — `ticks`, reduced
  // from durable 'tick' events — with RUNTIME state — `lastPokeMs`, a plain field the reduce never
  // touches, bumped when a 'poke' EPHEMERAL reaches its processEvent. The client seeds through
  // `liveSnapshot()` and reduces deltas with the SHIPPABLE store (the same one the browser hook uses).
  const itx = openItx(freshCtx("lsruntime"));
  await seedSources(itx, ["presence"]);
  // PresenceProcessor's contract consumes the EPHEMERAL 'poke', so its subscription must NAME it: the ONE
  // consumes rule (absent = durable events only; naming a type opts its ephemerals in) sits in
  // front of the facet's own contract filter — hence `consumes` on the enable.
  const presenceFacet =
    "itx.facets.get('presence', { source: \"itx.kv.get('src/presence.js')\", className: 'PresenceDurableObject' })";
  await itx.enableProcessor("presence", {
    source: "itx.kv.get('src/presence.js')",
    className: "PresenceDurableObject",
    consumes: ["tick", "poke"],
  });
  // A FILTERED processor's facet only materializes on its first consumed push (the enablement
  // commit itself is filtered out), so `itx.facets.get('presence')` would be NO_FACET until the
  // first tick — materialize it once through the hosting door before the first door read.
  await itx.invoke(`${presenceFacet}.catchUpFromLog()`);

  const door = async (): Promise<{ rev: number; state: PresenceLive }> =>
    clone(await itx.invoke("itx.facets.get('presence').liveSnapshot()"));

  const { store } = await connectLiveState<PresenceLive>(itx, {
    key: "presence",
    name: "watch",
    door,
  });

  // Seed: reduced 0 ticks, runtime lastPokeMs 0 — the whole projection, read atomically through the door.
  expect(store.get()).toEqual({ ticks: 0, lastPokeMs: 0 });

  // REDUCED change: a durable 'tick' advances the reduce → one delta syncs `ticks`; runtime untouched.
  await itx.invoke("itx.append({ type: 'tick' })");
  await until("ticks synced", () => store.get()?.ticks === 1);
  expect(store.get()!.lastPokeMs).toBe(0);

  // RUNTIME change: a 'poke' EPHEMERAL event bumps the runtime field in processEvent (no reduce) →
  // one out-of-band delta syncs `lastPokeMs`; the reduced field is preserved.
  await itx.invoke("itx.append({ type: 'poke', ephemeral: true })");
  await until("poke synced", () => (store.get()?.lastPokeMs ?? 0) > 0);
  expect(store.get()!.ticks).toBe(1);

  // Both fields ride ONE chain: the producer's door and the patched client doc agree byte-for-byte.
  const seed = await door();
  expect(store.get()).toEqual(seed.state);
  expect(store.rev()).toBe(seed.rev);

  // A second reduced change still chains from here (no re-seed needed after the runtime delta).
  const pokedAt = store.get()!.lastPokeMs;
  await itx.invoke("itx.append({ type: 'tick' })");
  await until("second tick synced", () => store.get()?.ticks === 2);
  expect(store.get()).toEqual({ ticks: 2, lastPokeMs: pokedAt });
});

test("a payload-less live-state/changed event never rejects an append that already committed", async () => {
  // A commit-then-reject would be a lie in the ONE place clients decide between "safe to retry" and
  // "already happened". The DO never reads `payload.key` — the tab receives every key's deltas as
  // EVENTS and filters `payload.key` itself, so a bare event is the SUBSCRIBER's to skip.
  const itx = openItx(freshCtx("lsbare"));
  const seen: unknown[] = [];
  await itx.subscribe({
    name: "watch",
    consumes: [LIVE_STATE_CHANGED],
    target: (events: { payload?: { key?: string } }[]) => {
      for (const e of events)
        if (e.payload?.key === "avatar") seen.push(JSON.parse(JSON.stringify(e.payload)));
    },
  });
  // The lane itself works: a WELL-FORMED change payload for the watched key is delivered.
  await append(itx, {
    type: LIVE_STATE_CHANGED,
    ephemeral: true,
    payload: { key: "avatar", from: 0, to: 1, patch: [] },
  });
  await until("well-formed change delivered", () => seen.length >= 1);
  // A BARE change event (no payload) still commits-and-resolves.
  const [bare] = await append(itx, { type: LIVE_STATE_CHANGED, ephemeral: true });
  expect(bare.offset).toBeGreaterThan(0);
  expect(seen).toHaveLength(1); // the bare event reached the tab as an event and was filtered there
});
