// chunk.e2e.test.ts — row chunking LIVE: a >2MB body commits, round-trips byte-identically through
// the real DO SQLite (event_chunks), keeps offsets dense, and dedupes an idempotent chunked retry.
// (was proofs/prove_chunk.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const append = (itx: any, events: unknown[]) =>
  itx.invokeCapability(["itx", ["append", ...events]]);

test("5MB chunked body: single dense event, byte-identical round-trip, idempotent dedupe", async () => {
  const ctx = freshCtx("chunk");
  const itx = openItx(ctx);

  // A small event, then a 5MB body, then a small event — dense offsets on both sides. (The FIRST
  // commit also mints the woken record and the core reduce's ephemeral live-state delta at the
  // head; `small-before` is appended again right before `big` so the two receipts are adjacent —
  // a plain event changes no inline state, so nothing ephemeral lands between them.)
  await append(itx, [{ type: "small-before" }]);
  const [before] = await append(itx, [{ type: "small-before" }]);
  const blob = "y".repeat(5 * 1024 * 1024);
  const big = await append(itx, [{ type: "big", payload: { blob } }]);
  const [after] = await append(itx, [{ type: "small-after" }]);
  // 5MB body committed as ONE event (not split)
  expect(big.length).toBe(1);
  // chunked event is dense with its predecessor
  expect(big[0].offset).toBe(before.offset + 1);
  // and dense with its successor
  expect(after.offset).toBe(big[0].offset + 1);

  // Read it back through a FRESH session (same ctx) — a real storage reassembly, not an echo.
  const itx2 = openItx(ctx);
  const page = await itx2.invokeCapability(["itx", ["read", before.offset, 500]]);
  const back = page.events.find((e: { offset: number }) => e.offset === big[0].offset);
  // 5MB event reads back
  expect(back?.type).toBe("big");
  // 5MB body round-trips BYTE-IDENTICALLY
  expect(back?.payload?.blob).toBe(blob);
  // chunk rows invisible to paging (dense event list)
  expect(page.events.map((e: { type: string }) => e.type).join(",")).toBe("big,small-after");

  // An idempotent RETRY of a large chunked payload dedupes to the same offset.
  const keyed = { type: "big-keyed", payload: { blob }, idempotencyKey: "chunk-once" };
  const [k1] = await append(itx, [keyed]);
  const [k2] = await append(itx, [keyed]);
  // chunked idempotent retry dedupes to the same offset
  expect(k2.offset).toBe(k1.offset);
});
