// stream-chunked-bodies.e2e.test.ts — row chunking LIVE: a >2MB body commits, round-trips
// byte-identically through the real DO SQLite (event_chunks), keeps offsets dense, dedupes an
// idempotent chunked retry, rolls its chunk rows back with a mid-batch conflict, stays invisible to
// paging — and a surrogate pair straddling a chunk boundary survives (the serialized JSON is sliced
// by UTF-16 code units; a split emoji must not come back as U+FFFD).

import { expect, test } from "vitest";
import { append, freshCtx, openItx, readAll } from "./support/client.ts";

const readOne = async (itx: any, offset: number) =>
  (await itx.invoke(["itx", ["read", offset - 1, 1]])).events[0];

test("a ~256KB payload round-trips byte-identically (the in-bounds control)", async () => {
  const itx = openItx(freshCtx("chunkctl"));
  const blob = "x".repeat(256 * 1024);
  const [committed] = await append(itx, { type: "mid", payload: { blob } });
  expect((await readOne(itx, committed.offset)).payload.blob === blob).toBe(true);
});

test("5MB chunked body: single dense event, byte-identical round-trip, idempotent dedupe", async () => {
  const ctx = freshCtx("chunk");
  const itx = openItx(ctx);

  // A small event, then a 5MB body, then a small event — dense offsets on both sides. (The
  // context's constructor minted created + woken and the core reduce's ephemeral live-state delta
  // before any door opened; `small-before` is appended twice so the two receipts are adjacent — a
  // plain event changes no core state, so nothing ephemeral lands between them.)
  await append(itx, { type: "small-before" });
  const [before] = await append(itx, { type: "small-before" });
  const blob = "y".repeat(5 * 1024 * 1024);
  const big = await append(itx, { type: "big", payload: { blob } });
  const [after] = await append(itx, { type: "small-after" });
  expect(big.length).toBe(1); // 5MB body committed as ONE event (not split)
  expect(big[0].offset).toBe(before.offset + 1); // dense with its predecessor
  expect(after.offset).toBe(big[0].offset + 1); // and with its successor

  // Read it back through a FRESH session (same ctx) — a real storage reassembly, not an echo.
  const itx2 = openItx(ctx);
  const page = await itx2.invoke(["itx", ["read", before.offset, 500]]);
  const back = page.events.find((e: { offset: number }) => e.offset === big[0].offset);
  expect(back?.type).toBe("big");
  expect(back?.payload?.blob === blob).toBe(true); // byte-identical (identity check — never a 5MB diff)
  // chunk rows invisible to paging (dense event list)
  expect(page.events.map((e: { type: string }) => e.type).join(",")).toBe("big,small-after");

  // An idempotent RETRY of a large chunked payload dedupes to the same offset.
  const keyed = { type: "big-keyed", payload: { blob }, idempotencyKey: "chunk-once" };
  const [k1] = await append(itx, keyed);
  const [k2] = await append(itx, keyed);
  expect(k2.offset).toBe(k1.offset);
});

test("a chunked append followed by an idempotency CONFLICT in the same batch rolls back ALL chunk rows", async () => {
  // Chunk rows are the first multi-row write in the commit path; a torn mid-batch failure leaving
  // orphan chunk rows (or half a body) is the corruption class chunking introduces — the rollback
  // must be provably whole, and the allocator must burn no offsets for the refused batch.
  const itx = openItx(freshCtx("chunkrb"));
  const [pin] = await append(itx, { type: "pin", payload: { v: 1 }, idempotencyKey: "pin" });
  const blob = "r".repeat(3 * 1024 * 1024);
  await expect(
    append(
      itx,
      { type: "big-victim", payload: { blob } },
      { type: "pin", payload: { v: 2 }, idempotencyKey: "pin" }, // same key, DIFFERENT body → conflict
    ),
  ).rejects.toThrow(/idempotency key "pin" already names a different event/);
  // Nothing partial survived the rollback (presence/absence — woken shares the log)…
  const types = (await readAll(itx)).map((e) => e.type as string);
  expect(types.filter((t) => t === "pin")).toHaveLength(1);
  expect(types).not.toContain("big-victim");
  expect(pin.offset).toBeGreaterThan(0);
  // …and the allocator did not burn offsets for a rolled-back batch: a marker before a second
  // refused chunked batch and a probe after it land adjacent.
  const [marker] = await append(itx, { type: "marker" });
  await expect(
    append(
      itx,
      { type: "big-victim", payload: { blob } },
      { type: "pin", payload: { v: 3 }, idempotencyKey: "pin" },
    ),
  ).rejects.toThrow(/idempotency key "pin" already names a different event/);
  const [next] = await append(itx, { type: "after-rollback" });
  expect(next.offset).toBe(marker.offset + 1);
}, 60_000);

test("read paging across a chunked event keeps the scanned-offset-range proof honest", async () => {
  // Every processor cursor and gap repair trusts the scanned-offset-range proof; if chunk rows ever
  // leaked into the page arithmetic, cursors would advance to phantom offsets and repairs would
  // skip real events. A limit-N page counts EVENTS, its scannedThroughOffset is the last EVENT row's
  // offset when the page is full (never a chunk boundary), and consecutive pages chain.
  const itx = openItx(freshCtx("chunkpg"));
  const blob = "p".repeat(3 * 1024 * 1024);
  const [, e2] = await append(itx, { type: "e1" }, { type: "e2" });
  const [big] = await append(itx, { type: "big", payload: { blob } });
  const [e4, e5] = await append(itx, { type: "e4" }, { type: "e5" });
  // Page 1: a FULL page (limit 2 from just before e2) lands exactly ON the chunked event.
  const page1 = await itx.invoke(["itx", ["read", e2.offset - 1, 2]]);
  expect(page1.events.map((e: { offset: number }) => e.offset)).toEqual([e2.offset, big.offset]);
  expect(page1.scannedThroughOffset).toBe(big.offset); // the EVENT offset — never a chunk row's
  expect(page1.events[1].payload.blob === blob).toBe(true); // the body rode the page whole
  // Page 2 chains contiguously from the proof.
  const page2 = await itx.invoke(["itx", ["read", page1.scannedThroughOffset, 500]]);
  expect(page2.events.map((e: { offset: number }) => e.offset)).toEqual([e4.offset, e5.offset]);
  expect(page2.scannedThroughOffset).toBe(e5.offset);
}, 60_000);

const EVENT_CHUNK_SIZE = 512 * 1024; // must match src/stream/stream.ts
const EMOJI = String.fromCodePoint(0x1f600); // "grinning face" = high+low surrogate pair

test("a surrogate pair straddling a chunk boundary round-trips byte-identically", async () => {
  // The serialized JSON is sliced every EVENT_CHUNK_SIZE UTF-16 code units into TEXT cells; a
  // surrogate pair split across the boundary would be two LONE surrogates in two cells, which
  // SQLite's UTF-8 TEXT binding cannot hold — reassembly would hand back U+FFFD.
  const ctx = freshCtx("chunksur");
  const itx = openItx(ctx);

  // Where does the blob's first char land inside the server's serialized JSON? The server
  // serializes `{ ...input, createdAt }`; createdAt is appended AFTER, so the prefix before the
  // blob content equals this sample's prefix (index of MARKER = blob[0]'s position).
  const prefixLen = JSON.stringify({ type: "big", payload: { blob: "MARKER" } }).indexOf("MARKER");
  expect(prefixLen).toBeGreaterThan(0);

  // Put the HIGH surrogate at server-JSON index EVENT_CHUNK_SIZE-1 (last unit of chunk 0) so the
  // LOW surrogate lands at index EVENT_CHUNK_SIZE (first unit of chunk 1): the pair is split.
  const highAtBlobIndex = EVENT_CHUNK_SIZE - 1 - prefixLen;
  const blob = "a".repeat(highAtBlobIndex) + EMOJI + "a".repeat(64);
  const hi = blob.charCodeAt(highAtBlobIndex);
  expect(hi).toBeGreaterThanOrEqual(0xd800);
  expect(hi).toBeLessThanOrEqual(0xdbff);

  const [committed] = await append(itx, { type: "big", payload: { blob } });
  expect(committed.payload.blob).toBe(blob); // the echo is the in-memory object — always intact

  // Read back through a FRESH session → a real reassembly from event_chunks, not an echo.
  const back = await readOne(openItx(ctx), committed.offset);
  expect(back).toBeTruthy();
  const got: string = back.payload.blob;
  const window = (s: string) =>
    JSON.stringify(
      [...s.slice(highAtBlobIndex - 1, highAtBlobIndex + 2)].map((c) =>
        c.codePointAt(0)?.toString(16),
      ),
    );
  expect(
    got === blob,
    `blob NOT byte-identical around the split boundary — expected code units ${window(blob)}, ` +
      `got ${window(got)} (U+fffd = replacement char)`,
  ).toBe(true);
});
