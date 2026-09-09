// live-state-chains-client-side.e2e.test.ts — LIVE STATE, client-chained: each change event says
// "I am the diff relative to rev X"; the stream keeps NO per-key state — a delta is an ordinary
// ephemeral event like any other. Live state is not a subscription MODE: a client subscribes to the
// one event type (`consumes: ["events.iterate.com/live-state/changed"]`), receives every key's deltas
// in ordinary event batches, and keeps its key. The client is THE SHIPPED ONE (src/client:
// `connectLiveState` over `createLiveStateStore`): subscribe → read the producer's door {rev, state}
// → apply payloads whose `from` matches the held rev, re-read the door on any mismatch. Proves: the
// client loop converges byte-identical with the door, the steady path needs zero re-reads, revisions
// chain exactly (mini-app AND processor flavors), out-of-order/duplicate frames are harmless, the
// change events are unconsumable, REDUCED ⊕ RUNTIME state rides ONE projection through the same
// store, and a malformed delta is the subscriber's to skip — never a rejected append.

import { expect, test } from "vitest";
import { connectLiveState, type LiveStateItx } from "../src/client/live-state-client.ts";
import type { LiveStateDelta, LiveStateSeed } from "../src/client/live-state-store.ts";
import { append, freshCtx, openItx, until } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The shipped client over a session whose delivery the test can SEE and DRIVE: every frame for the
 *  key is recorded on its way into the store (so `dropped` is frames − applied − reseeds, and an old
 *  frame can be replayed), and `inject` hands the store a frame exactly as the wire would (a
 *  duplicate, a gap). `applied` is the store's notifications less the heals (a heal seeds — and
 *  notifies — too); `reseeds` is the client's `onResync("healed")` count. */
async function watchedLiveState<S>(
  itx: any,
  input: { key: string; name: string; door: () => Promise<LiveStateSeed<S>> },
) {
  const frames: LiveStateDelta[] = [];
  const counts = { reseeds: 0, notifications: 0 };
  let deliver: (events: unknown[], range: unknown) => void = () => undefined;
  const tapped: LiveStateItx = {
    subscribe: (subscription) => {
      deliver = (events, range) => {
        for (const e of events) {
          const delta = clone((e as { payload: LiveStateDelta }).payload);
          if (delta.key === input.key) frames.push(delta);
        }
        subscription.target(events, range);
      };
      return itx.subscribe({ ...subscription, target: deliver });
    },
  };
  const { store } = await connectLiveState<S>(tapped, {
    ...input,
    onResync: (result) => {
      if (result !== "healed") throw result;
      counts.reseeds++;
    },
  });
  store.subscribe(() => counts.notifications++); // after the first seed: applied patches + heals
  return {
    store,
    frames,
    inject: (delta: LiveStateDelta) => deliver([{ payload: delta }], {}),
    get applied() {
      return counts.notifications - counts.reseeds;
    },
    get reseeds() {
      return counts.reseeds;
    },
    get dropped() {
      return frames.length - this.applied - this.reseeds;
    },
  };
}

test("live state chains client-side from the door — mini-app + processor flavors", async () => {
  const itx = openItx(freshCtx("live"));

  // ── mini-app flavor: the chatroom (SDK LiveState helper), behind the rewrite rule itx.chat ──
  await itx.provide("itx.chat", [
    "itx",
    "facets",
    ["get", "chatroom", { source: SOURCES.chatroom, className: "ChatroomDurableObject" }],
  ]);

  const chat = await watchedLiveState<{ messages: { text: string }[] }>(itx, {
    key: "chat",
    name: "chatwatch",
    door: async () => clone(await itx.invoke("itx.chat.state()")),
  });
  const chatSeedRev = chat.store.rev()!; // an incarnation EPOCH, not 0 — reborn holders never re-use old revs
  expect(typeof chatSeedRev).toBe("number");
  expect(chat.store.get()!.messages.length).toBe(0);

  await itx.invoke(["itx", "chat", ["post", "jonas", "hi"]]);
  await itx.invoke(["itx", "chat", ["post", "jonas", "again"]]);
  await until("two messages", () => chat.store.get()?.messages.length === 2);
  // steady path: two patches applied, ZERO re-reads; client rev chained epoch→+1→+2
  expect(chat.applied).toBe(2);
  expect(chat.reseeds).toBe(0);
  expect(chat.store.rev()).toBe(chatSeedRev + 2);
  expect(chat.store.get()!.messages[1].text).toBe("again");

  const door = clone(await itx.invoke("itx.chat.state()")) as { rev: number; state: unknown };
  // door and patched client doc are byte-identical
  expect(door.rev).toBe(chat.store.rev());
  expect(JSON.stringify(door.state)).toBe(JSON.stringify(chat.store.get()));

  // out-of-order / duplicate frames are harmless: replay an old payload, then a gapped one
  chat.inject(clone(chat.frames[0]!)); // replay a real old frame — at-or-behind the held rev
  expect(chat.dropped).toBe(1);
  expect(chat.store.get()!.messages.length).toBe(2);

  const rev = chat.store.rev()!;
  chat.inject({ key: "chat", from: rev + 5, to: rev + 6, patch: [] });
  await until("gap healed", () => chat.reseeds >= 1);
  // a gapped frame triggers one door re-read and converges
  expect(JSON.stringify(chat.store.get())).toBe(JSON.stringify(door.state));
  expect(chat.store.rev()).toBe(chatSeedRev + 2);
  expect(chat.applied).toBe(2);

  // ── processor flavor: chunky's reduce, door = liveSnapshot() ──
  await itx.enableProcessor("chunky", {
    source: SOURCES.chunky,
    className: "ChunkyDurableObject",
  });
  const proc = await watchedLiveState<{ marks: number; chunks: number }>(itx, {
    key: "chunky",
    name: "chunkywatch",
    door: async () => clone(await itx.invoke("itx.facets.get('chunky').liveSnapshot()")),
  });
  const seedRev = proc.store.rev()!;
  expect(typeof seedRev).toBe("number");
  expect(proc.store.get()!.marks).toBe(0);

  await itx.invoke(`itx.append({ type: 'mark' })`);
  await until("mark reduced", () => (proc.store.get()?.marks ?? 0) >= 1);
  await itx.invoke(`itx.append({ type: 'mark' })`);
  await until("second mark", () => (proc.store.get()?.marks ?? 0) >= 2);
  // processor patches chained from the seed rev, zero re-reads; the doc matches the projection
  expect(proc.applied).toBe(2);
  expect(proc.reseeds).toBe(0);
  expect(proc.store.get()).toEqual({ marks: 2, chunks: 0 });

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
  // PresenceProcessor's contract consumes the EPHEMERAL 'poke', so its subscription must NAME it: the ONE
  // consumes rule (absent = durable events only; naming a type opts its ephemerals in) sits in
  // front of the facet's own contract filter — hence `consumes` on the enable. The facet is
  // materialized at enable time whatever the filter says (subscription-delivery.ts), so the door
  // answers before the first consumed event.
  await itx.enableProcessor("presence", {
    source: SOURCES.presence,
    className: "PresenceDurableObject",
    consumes: ["tick", "poke"],
  });

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
    consumes: ["events.iterate.com/live-state/changed"],
    target: (events: { payload?: { key?: string } }[]) => {
      for (const e of events)
        if (e.payload?.key === "avatar") seen.push(JSON.parse(JSON.stringify(e.payload)));
    },
  });
  // The lane itself works: a WELL-FORMED change payload for the watched key is delivered.
  await append(itx, {
    type: "events.iterate.com/live-state/changed",
    ephemeral: true,
    payload: { key: "avatar", from: 0, to: 1, patch: [] },
  });
  await until("well-formed change delivered", () => seen.length >= 1);
  // A BARE change event (no payload) still commits-and-resolves.
  const [bare] = await append(itx, {
    type: "events.iterate.com/live-state/changed",
    ephemeral: true,
  });
  expect(bare.offset).toBeGreaterThan(0);
  expect(seen).toHaveLength(1); // the bare event reached the tab as an event and was filtered there
});
