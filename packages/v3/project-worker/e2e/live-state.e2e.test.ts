// live-state.e2e.test.ts — LIVE STATE, client-chained (the owner's simplification): each change event
// says "I am the diff relative to rev X"; the stream is a PURE FORWARDER (no per-row server state).
// The client does: subscribe → read the producer's door {rev, state} → apply payloads whose `from`
// matches its rev, re-read the door on any mismatch. Proves: the client loop converges byte-identical
// with the door, the steady path needs zero re-reads, revisions chain exactly (mini-app AND processor
// flavors), out-of-order/duplicate frames are harmless, and the change events are unconsumable.
// (was proofs/prove_livestate.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { liveClient, type Delta } from "./support/live-client.ts";
import { seedSources } from "./support/sources.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test("live state chains client-side from the door — mini-app + processor flavors", async () => {
  const itx = openItx(freshCtx("live"));
  await seedSources(itx, ["chatroom", "chunky"]);

  // ── mini-app flavor: the chatroom (SDK liveState helper) ──
  await itx.provide(
    "itx.chat",
    `itx.load("itx.kv.get('src/chatroom.js')").getDurableObjectClass('Chatroom').get()`,
  );

  const chat = liveClient(async () => clone(await itx.invokeCapability("itx.chat.state()")));
  await itx.subscribe({
    name: "chatwatch",
    liveState: { key: "chat" },
    target: (u: unknown) => chat.consume(clone(u) as Delta),
  });
  await chat.seed();
  const chatSeedRev = chat.rev!; // an incarnation EPOCH, not 0 — reborn holders never re-use old revs
  expect(typeof chatSeedRev).toBe("number");
  expect((chat.doc as { messages: unknown[] }).messages.length).toBe(0);

  await itx.invokeCapability(["itx", "chat", ["post", "jonas", "hi"]]);
  await itx.invokeCapability(["itx", "chat", ["post", "jonas", "again"]]);
  await until("two messages", () => (chat.doc as { messages?: unknown[] })?.messages?.length === 2);
  // steady path: two patches applied, ZERO re-reads
  expect(chat.applied).toBe(2);
  expect(chat.reseeds).toBe(0);
  // client rev chained epoch→+1→+2
  expect(chat.rev).toBe(chatSeedRev + 2);
  // applyPatch converged on the server value
  expect((chat.doc as { messages: { text: string }[] }).messages[1].text).toBe("again");

  const door = clone(await itx.invokeCapability("itx.chat.state()")) as {
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

  // ── processor flavor: chunky's fold, door = liveSnapshot() ──
  await itx.enableProcessor("chunky", {
    source: "itx.kv.get('src/chunky.js')",
    className: "Chunky",
  });
  const proc = liveClient(async () =>
    clone(await itx.invokeCapability("itx.facets.get('chunky').liveSnapshot()")),
  );
  await itx.subscribe({
    name: "chunkywatch",
    liveState: { key: "chunky" },
    target: (u: unknown) => proc.consume(clone(u) as Delta),
  });
  await proc.seed();
  const seedRev = proc.rev!;
  expect(typeof seedRev).toBe("number");
  expect((proc.doc as { marks: number }).marks).toBe(0);

  await itx.invokeCapability(`itx.append({ type: 'mark' })`);
  await until("mark folded", () => ((proc.doc as { marks?: number })?.marks ?? 0) >= 1);
  await itx.invokeCapability(`itx.append({ type: 'mark' })`);
  await until("second mark", () => ((proc.doc as { marks?: number })?.marks ?? 0) >= 2);
  // processor patches chained from the seed rev, zero re-reads
  expect(proc.applied).toBe(2);
  expect(proc.reseeds).toBe(0);
  // patched client doc matches the projection
  expect((proc.doc as { marks: number; chunks: number }).marks).toBe(2);
  expect((proc.doc as { marks: number; chunks: number }).chunks).toBe(0);

  // ── the loop guard: nothing consumed the change events ──
  const snap = await itx.invokeCapability("itx.facets.get('chunky').snapshot()");
  expect(JSON.stringify(snap).includes("live-state")).toBe(false);
});
